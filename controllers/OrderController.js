import mongoose from "mongoose";
import { Order } from "../models/Order.js";
import User from "../models/User.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import dotenv from "dotenv";

dotenv.config();

import crypto from "crypto";
import qrcode from "qrcode";

// Инициализация S3 (дублирование из UserController, в идеале вынести в отдельный сервис)
const bucketName = process.env.BUCKET_NAME;
const bucketRegion = process.env.BUCKET_REGION;
const accessKey = process.env.BUCKET_ACCESS_KEY;
const secretAccessKey = process.env.BUCKET_SECRET_ACCESS_KEY;

const s3 = new S3Client({
  credentials: {
    accessKeyId: accessKey,
    secretAccessKey: secretAccessKey,
  },
  region: bucketRegion,
});

// --- Bidding Engine & Order Management ---

// 1. Создание заказа (Заказчик)
export const createOrder = async (req, res) => {
  try {
    const { cargo, route, pricing, aiAnalysis, customerId } = req.body;
    
    // TODO: Получать userId из токена (req.user._id)
    // Пока берем из body для теста или fallback
    const finalCustomerId = customerId || req.user?._id;

    const newOrder = new Order({
      customer: finalCustomerId,
      cargoDetails: cargo, // Map 'cargo' from body to 'cargoDetails'
      route,
      pricing: {
        customerOffer: pricing?.customerOffer || 0,
        currency: "RUB"
      },
      aiAnalysis,
      status: "PUBLISHED" // Сразу публикуем для торгов
    });

    await newOrder.save();
    res.status(201).json(newOrder);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// 2. Получение списка заказов (Фильтры для ролей)
export const getOrders = async (req, res) => {
  try {
    const { status, role, userId } = req.query;
    let filter = {};

    if (status) filter.status = status;
    
    // Если заказчик — видит только свои
    if (role === 'CUSTOMER') {
        filter.customer = userId;
    }
    // Если логист — видит доступные для торгов или свои принятые
    else if (role === 'LOGISTICIAN') {
        filter.$or = [
            { status: 'PUBLISHED' },
            { 'bids.logistician': userId },
            { 'executor.logistician': userId }
        ];
    }
    // Если водитель — видит назначенные ему (через машину)
    else if (role === 'DRIVER') {
        // 1. Находим машину, где водитель сейчас за рулем
        const vehicle = await mongoose.model("Vehicle").findOne({ currentDriver: userId });
        
        if (vehicle) {
            // 2. Ищем заказы, назначенные на эту машину ИЛИ напрямую на водителя (для совместимости)
            filter.$or = [
                { 'executor.vehicle': vehicle._id },
                { 'executor.driver': userId }
            ];
        } else {
            // Если машины нет, ищем только по водителю
            filter['executor.driver'] = userId;
        }
    }

    const orders = await Order.find(filter)
      .populate('customer', 'name rating')
      .populate('executor.vehicle')
      .populate('bids.logistician', 'name rating') // Добавлено: подтягиваем инфо о логисте в ставках
      .sort({ createdAt: -1 });
      
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Получить один заказ по ID (для страницы деталей)
export const getOrderById = async (req, res) => {
    try {
        const { id } = req.params;
        const order = await Order.findById(id)
            .populate('customer', 'name phone rating')
            .populate('executor.vehicle')
            .populate('executor.driver', 'name phone')
            .populate('executor.logistician', 'name phone')
            .populate('bids.logistician', 'name rating'); // Добавлено: инфо о логисте в ставках

        if (!order) {
            return res.status(404).json({ error: "Order not found" });
        }
        res.json(order);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// 3. Сделать ставку (Логист)
export const placeBid = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { amount, comment, logisticianId } = req.body;

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });

    if (order.status !== 'PUBLISHED' && order.status !== 'NEGOTIATION') {
        return res.status(400).json({ error: "Order is not open for bidding" });
    }

    // Добавляем ставку
    order.bids.push({
        logistician: logisticianId,
        amount,
        comment,
        status: 'PENDING'
    });
    
    order.status = 'NEGOTIATION';
    await order.save();

    res.json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// 4. Принять ставку (Заказчик)
export const acceptBid = async (req, res) => {
  try {
    const { orderId, bidId } = req.params;
    
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const bid = order.bids.id(bidId);
    if (!bid) return res.status(404).json({ error: "Bid not found" });

    // Обновляем статусы
    bid.status = 'ACCEPTED';
    order.status = 'APPROVED';
    order.pricing.finalPrice = bid.amount;
    order.executor.logistician = bid.logistician;

    // Отклоняем остальные ставки
    order.bids.forEach(b => {
        if (b._id.toString() !== bidId) {
            b.status = 'REJECTED';
        }
    });

    await order.save();
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// 5. Назначить водителя и машину (Логист)
export const assignDriver = async (req, res) => {
    try {
        const { orderId } = req.params;
        const { driverId, vehicleId } = req.body;

        const order = await Order.findById(orderId);
        if (!order) return res.status(404).json({ error: "Order not found" });

        if (order.status !== 'APPROVED') {
            return res.status(400).json({ error: "Order must be approved first" });
        }

        // Если передан только vehicleId, назначаем только машину
        if (vehicleId) order.executor.vehicle = vehicleId;
        
        // Если передан driverId, назначаем водителя
        if (driverId) order.executor.driver = driverId;

        // Если назначена хотя бы машина, переводим статус
        if (vehicleId || driverId) {
            order.status = 'ASSIGNED';
        }

        await order.save();
        res.json(order);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// 6. Смена статуса водителем (State Machine)
export const updateDriverStatus = async (req, res) => {
    try {
        const { orderId } = req.params;
        const { status } = req.body; // AT_PICKUP, IN_TRANSIT, AT_DROP, DELIVERED
        
        const allowedTransitions = {
            'ASSIGNED': ['AT_PICKUP'],
            'AT_PICKUP': ['IN_TRANSIT'],
            'IN_TRANSIT': ['AT_DROP'],
            'AT_DROP': ['DELIVERED']
        };

        const order = await Order.findById(orderId);
        if (!order) return res.status(404).json({ error: "Order not found" });

        const currentStatus = order.status;
        // Простая проверка перехода (можно усложнить)
        if (currentStatus !== status && !allowedTransitions[currentStatus]?.includes(status)) {
             // Разрешаем повторную отправку того же статуса, но запрещаем невалидные переходы
             // Если статус тот же, ничего не делаем
             if (currentStatus === status) return res.json(order);

             return res.status(400).json({ 
                error: `Invalid transition from ${currentStatus} to ${status}` 
            });
        }

        order.status = status;
        await order.save();
        res.json(order);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// 7. Загрузка PoD (Proof of Delivery)
export const uploadPoD = async (req, res) => {
    try {
        const { orderId } = req.params;
        const files = req.files; // массив файлов от multer

        if (!files || files.length === 0) {
            return res.status(400).json({ error: "No files uploaded" });
        }

        const order = await Order.findById(orderId);
        if (!order) return res.status(404).json({ error: "Order not found" });

        const uploadedUrls = [];

        // Загружаем каждый файл в S3
        for (const file of files) {
            const fileName = `pod_${orderId}_${Date.now()}_${file.originalname}`;
            const params = {
                Bucket: bucketName,
                Key: fileName,
                Body: file.buffer,
                ContentType: file.mimetype,
            };

            const command = new PutObjectCommand(params);
            await s3.send(command);
            
            // Формируем URL (или просто храним Key, но для простоты вернем Key/Url)
            // В реальном проекте лучше хранить Key и генерировать SignedUrl при чтении
            uploadedUrls.push(fileName); 
        }

        order.proofOfDelivery = {
            photos: uploadedUrls,
            submittedAt: new Date()
        };
        
        // Если статус еще не DELIVERED, ставим его
        if (order.status !== 'DELIVERED') {
            order.status = 'DELIVERED';
        }

        await order.save();
        res.json({ message: "PoD uploaded successfully", order });
    } catch (error) {
        console.error("PoD upload error:", error);
        res.status(500).json({ error: error.message });
    }
};

// 8. Генерация QR кода для подтверждения получения
export const generateReceiptQR = async (req, res) => {
    try {
        const { orderId } = req.params;
        const order = await Order.findById(orderId);
        if (!order) return res.status(404).json({ error: "Order not found" });

        // Генерируем токен, если его еще нет
        if (!order.receiptToken) {
            order.receiptToken = crypto.randomBytes(16).toString("hex");
            await order.save();
        }

        // Данные для QR кода (например, URL для сканирования или JSON)
        // В реальном приложении это может быть URL фронтенда, который отправляет запрос на confirmReceipt
        const qrData = JSON.stringify({ orderId: order._id, token: order.receiptToken });
        
        const qrCodeImage = await qrcode.toDataURL(qrData);

        res.json({ qrCode: qrCodeImage, token: order.receiptToken });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// 9. Подтверждение получения по QR коду
export const confirmReceipt = async (req, res) => {
    try {
        const { orderId } = req.params;
        const { token } = req.body;

        const order = await Order.findById(orderId);
        if (!order) return res.status(404).json({ error: "Order not found" });

        if (!order.receiptToken || order.receiptToken !== token) {
            return res.status(400).json({ error: "Invalid or missing receipt token" });
        }

        // Подтверждаем доставку
        if (order.status !== 'DELIVERED') {
            order.status = 'DELIVERED';
        }
        
        // Можно также отметить, что заказчик подтвердил
        if (!order.proofOfDelivery) {
            order.proofOfDelivery = {};
        }
        order.proofOfDelivery.verifiedByCustomer = true;

        await order.save();
        res.json({ message: "Receipt confirmed successfully", order });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// --- Legacy / Helpers ---
export const getAllOrders = async (req, res) => {
  try {
    const orders = await Order.find()
      .populate('customer', 'name rating')
      .sort({ createdAt: -1 });
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const updateOrder = async (req, res) => {
    // Generic update implementation
    const { id } = req.params;
    const updated = await Order.findByIdAndUpdate(id, req.body, { new: true });
    res.json(updated);
};

export const deleteOrder = async (req, res) => {
  try {
    const { id } = req.body; // Или req.params, если передаете в URL
    if (!id) return res.status(400).json({ error: "Order ID is required" });

    const deletedOrder = await Order.findByIdAndDelete(id);
    if (!deletedOrder) {
      return res.status(404).json({ error: "Order not found" });
    }
    res.json({ message: "Order deleted successfully", order: deletedOrder });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const archiveOrder = async (req, res) => {
    // ... implementation
     res.status(501).json({message: "Not implemented"});
};

export const restoreOrder = async (req, res) => {
    // ... implementation
     res.status(501).json({message: "Not implemented"});
};
