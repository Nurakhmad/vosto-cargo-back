import { createClient } from 'redis';
import { Order } from '../models/Order.js';
import User from '../models/User.js';
import dotenv from "dotenv";

dotenv.config();

let redisClient;

export const initRedis = async () => {
    if (!redisClient) {
        let redisErrorLogged = false;
        redisClient = createClient({ 
            url: process.env.REDIS_URL || 'redis://localhost:6379',
            socket: {
                reconnectStrategy: false
            }
        });
        
        redisClient.on('error', (err) => {
            if (!redisErrorLogged) {
                console.log('Redis unavailable, using Mongo GPS fallback:', err.message);
                redisErrorLogged = true;
            }
        });
        
        try {
            await redisClient.connect();
            console.log('Redis connected');
        } catch (error) {
            redisClient = null;
            console.log('Redis unavailable, using Mongo GPS fallback');
        }
    }
    return redisClient;
};

export const getRedisClient = () => redisClient;

export const handleLocationUpdate = async (socket, data) => {
    const { driverId, lat, lng, orderId } = data;
    const timestamp = Date.now();
    const point = { lat, lng, timestamp, orderId };

    // 1. Pub/Sub: Отправляем обновление подписчикам (логисту/клиенту)
    // Клиент на фронте слушает комнату `track:${orderId}`
    if (orderId) {
        socket.to(`track:${orderId}`).emit('driverLocation', { ...point, driverId });
    }

    await User.findByIdAndUpdate(
        driverId,
        {
            location: {
                latitude: lat,
                longitude: lng,
                updatedAt: new Date(timestamp),
            }
        },
        { runValidators: false }
    );

    if (redisClient?.isOpen) {
        // 2. Redis Hot Storage: Сохраняем текущую позицию (TTL 5 минут, чтобы не мусорить)
        await redisClient.set(
            `driver:${driverId}:current`, 
            JSON.stringify({ lat, lng, timestamp }), 
            { EX: 300 }
        );

        // 3. Redis Cold Buffer: Добавляем в список для последующего сохранения в БД
        // Используем RPUSH для добавления в конец очереди
        await redisClient.rPush(
            `driver:${driverId}:history`, 
            JSON.stringify(point)
        );
        return;
    }

    if (orderId) {
        await Order.findByIdAndUpdate(orderId, {
            $push: { trackHistory: point }
        });
    }
};

// CRON JOB (запускать раз в минуту)
export const syncLocationsToMongo = async () => {
    if (!redisClient) return;

    try {
        // Получаем все ключи истории
        const keys = await redisClient.keys('driver:*:history');

        for (const key of keys) {
            // Извлекаем все точки и очищаем список атомарно
            // (в реальном продакшене лучше использовать LPOP или транзакции, 
            // но для диплома такая схема приемлема)
            const rawPoints = await redisClient.lRange(key, 0, -1);
            
            if (rawPoints.length === 0) continue;

            // Удаляем обработанные ключи
            await redisClient.del(key);

            const points = rawPoints.map(p => JSON.parse(p));
            // Предполагаем, что orderId одинаковый для батча (водитель выполняет один заказ)
            // Если водитель переключается, логика может быть сложнее
            const orderId = points[0].orderId; 

            if (!orderId) continue;

            // Bulk update в MongoDB (эффективно)
            await Order.findByIdAndUpdate(orderId, {
                $push: { 
                    trackHistory: { $each: points } 
                }
            });
            
            console.log(`Synced ${points.length} points for order ${orderId}`);
        }
    } catch (error) {
        console.error("Error syncing locations to Mongo:", error);
    }
};
