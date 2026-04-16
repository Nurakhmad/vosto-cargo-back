import Vehicle from "../models/Vehicle.js";
import User from "../models/User.js";

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalizePhone = (phone = "") => phone.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");

// Добавить машину в парк
export const addVehicle = async (req, res) => {
  try {
    const { plateNumber, type, capacity, brand, ownerId } = req.body;

    const newVehicle = new Vehicle({
      plateNumber,
      type,
      capacity,
      brand,
      owner: ownerId, // ID логиста
      status: 'AVAILABLE'
    });

    await newVehicle.save();
    
    // Обновляем профиль логиста
    await User.findByIdAndUpdate(ownerId, {
        $push: { 'logisticianProfile.managedFleets': newVehicle._id }
    });

    res.status(201).json(newVehicle);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Получить список машин логиста
export const getMyFleet = async (req, res) => {
    try {
        const { ownerId } = req.query;
        const vehicles = await Vehicle.find({ owner: ownerId }).populate('currentDriver', 'name phone email');
        res.json(vehicles);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// Назначить водителя на машину (постоянное закрепление)
export const assignDriverToVehicle = async (req, res) => {
    try {
        const { vehicleId, driverId } = req.body;
        
        const vehicle = await Vehicle.findById(vehicleId);
        if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });

        vehicle.currentDriver = driverId;
        await vehicle.save();

        // Обновляем профиль водителя
        await User.findByIdAndUpdate(driverId, {
            'driverProfile.currentVehicle': vehicleId
        });

        res.json(vehicle);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// Добавить водителя в штат по телефону. Email/Telegram ID оставлены для старых аккаунтов.
export const addDriverByTelegramId = async (req, res) => {
    try {
        const { logisticianId, phone, email, telegramId, driverIdentifier } = req.body;
        const identifier = (phone || email || driverIdentifier || telegramId || "").trim();
        const normalizedPhone = normalizePhone(identifier);

        if (!logisticianId || !identifier) {
            return res.status(400).json({ error: "Logistician ID and driver phone are required" });
        }

        // 1. Ищем водителя
        const driver = await User.findOne({
            $or: [
                { phone: normalizedPhone },
                { email: { $regex: `^${escapeRegExp(identifier)}$`, $options: "i" } },
                { telegramId: identifier }
            ]
        });
        if (!driver) {
            return res.status(404).json({ error: "Driver not found with this phone" });
        }

        // 2. Проверяем роль
        if (driver.role !== 'DRIVER') {
            return res.status(400).json({ error: "User is not a driver" });
        }

        // 3. Проверяем, не нанят ли уже
        if (driver.driverProfile?.employer) {
             // Если уже работает на нас - ок
             if (driver.driverProfile.employer.toString() === logisticianId) {
                 return res.status(200).json({ message: "Driver already in your fleet", driver });
             }
             // Если работает на другого - ошибка
             return res.status(400).json({ error: "Driver is already employed by another company" });
        }

        // 4. Обновляем водителя (нанимаем)
        // Важно: используем $set для атомарного обновления
        await User.findByIdAndUpdate(driver._id, {
            $set: {
                'driverProfile.employer': logisticianId,
                'driverProfile.status': 'FREE'
            }
        });

        // 5. Обновляем логиста (добавляем в список)
        await User.findByIdAndUpdate(logisticianId, {
            $addToSet: { 'logisticianProfile.drivers': driver._id }
        });

        // Возвращаем обновленного водителя (повторно читаем, чтобы вернуть актуальные данные)
        const updatedDriver = await User.findById(driver._id);
        res.json({ message: "Driver added successfully", driver: updatedDriver });

    } catch (error) {
        console.error("Add driver error:", error);
        res.status(500).json({ error: error.message });
    }
};

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import dotenv from "dotenv";

dotenv.config();

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

// Получить последние локации всех водителей логиста
export const getFleetLocations = async (req, res) => {
    try {
        const { logisticianId } = req.query;
        
        if (!logisticianId) {
            return res.status(400).json({ error: "Logistician ID required" });
        }

        const logistician = await User.findById(logisticianId);
        if (!logistician) {
            return res.status(404).json({ error: "Logistician not found" });
        }

        const driverIds = logistician.logisticianProfile?.drivers || [];
        if (driverIds.length === 0) {
            return res.json([]);
        }

        const drivers = await User.find({
            '_id': { $in: driverIds },
            'location.latitude': { $exists: true } // Только те, у кого есть координаты
        }).select('name location driverProfile');

        res.json(drivers);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};
// Получить список моих водителей
export const getMyDrivers = async (req, res) => {
    try {
        // Поддерживаем и logisticianId, и ownerId для совместимости с фронтендом
        const logisticianId = req.query.logisticianId || req.query.ownerId;
        
        if (!logisticianId) {
            return res.status(400).json({ error: "Logistician ID (or ownerId) required" });
        }

        // 1. Ищем логиста
        const logistician = await User.findById(logisticianId);
        
        if (!logistician) {
            return res.status(404).json({ error: "Logistician not found" });
        }

        // 2. Получаем ID водителей из профиля
        const driverIds = logistician.logisticianProfile?.drivers || [];

        if (driverIds.length === 0) {
            return res.json([]);
        }

        // 3. Находим самих водителей по списку ID
        const drivers = await User.find({
            '_id': { $in: driverIds }
        }).select('name phone email telegramId avatar driverProfile role'); // Выбираем только нужные поля

        // 4. Генерируем Signed URL для аватаров, если нужно
        const driversWithAvatars = await Promise.all(drivers.map(async (driver) => {
            const driverObj = driver.toObject();
            if (driverObj.avatar && !driverObj.avatar.startsWith("http")) {
                try {
                    const getObjectParams = {
                        Bucket: bucketName,
                        Key: driverObj.avatar,
                    };
                    const command = new GetObjectCommand(getObjectParams);
                    driverObj.avatar = await getSignedUrl(s3, command, { expiresIn: 3600 });
                } catch (err) {
                    console.error(`Error generating signed URL for driver ${driver._id}:`, err);
                }
            }
            return driverObj;
        }));

        res.json(driversWithAvatars);
    } catch (error) {
        console.error("Error getting drivers:", error);
        res.status(500).json({ error: error.message });
    }
};
