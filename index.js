import express from "express";
import http from "http";
import { Server } from "socket.io";
import mongoose from "mongoose";
import chalk from "chalk";
import dotenv from "dotenv";
import multer from "multer";
import cors from "cors";
import crypto from "crypto";

dotenv.config();

import * as UserController from "./controllers/UserController.js";
import * as OrderController from "./controllers/OrderController.js";
import * as FleetController from "./controllers/FleetController.js";
import * as AIController from "./controllers/AIController.js";
import * as SearchController from "./controllers/SearchController.js";
import ParseController from "./controllers/ParseController.js";
// import { startTelegramListener } from "./controllers/TelegaParser.mjs";
import { getDistance } from "./controllers/RouteController.js";
import { getShippingCalculation } from "./controllers/DeepSeek.js";
import { sendSupportMessage } from "./controllers/Support.js";
import ratingRouter from "./controllers/RatingController.js";
import { startBot } from "./controllers/BotTelega.js";

// Новые сервисы и middleware
import { initRedis, handleLocationUpdate } from "./services/TrackingService.js";
import { parseOrderRequest } from "./services/AIService.js";
import { checkRole } from "./middleware/roleMiddleware.js";

// Robokassa не зависит от Order
// import { Order } from "./models/Order.js";

// Модель пользователя — понадобится для подписки
import User from "./models/User.js";

import "./jobs.js";

const errorMsg = chalk.bgWhite.redBright;
const successMsg = chalk.bgGreen.white;

// Инициализация Redis
initRedis().catch(err => console.error(errorMsg("Redis init error:", err)));

mongoose
  .connect(process.env.MONGO_SRV)
  .then(() => console.log(successMsg("DB ok")))
  .catch((err) => console.log(errorMsg("DB error:", err)));

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Socket.io connection handler
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Клиент (логист/заказчик) подписывается на трекинг заказа
  socket.on('joinOrder', (orderId) => {
    socket.join(`track:${orderId}`);
    console.log(`User ${socket.id} joined order ${orderId}`);
  });

  // Водитель отправляет координаты
  socket.on('updateLocation', async (data) => {
    // data: { driverId, lat, lng, orderId }
    try {
      await handleLocationUpdate(socket, data);
    } catch (err) {
      console.error("Location update error:", err);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

app.use(
  cors({
    origin: "*",
    methods: ["GET", "PATCH", "POST", "PUT", "DELETE"],
    credentials: true,
  })
);

app.options("*", cors());

// Robokassa callback присылает application/x-www-form-urlencoded,
// поэтому urlencoded ПЕРЕД json
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const storage = multer.memoryStorage();
const upload = multer({ storage });

// ---------- Маршруты для пользователей ----------
app.post("/register", UserController.register);
app.post("/login", UserController.login);
app.post("/subscribe", UserController.getSubscribe);
app.post("/save-location", UserController.saveLocation);

app.get("/getUserById/:id", UserController.getUser);
app.post(
  "/uploadPhoto/:id",
  upload.single("photo"),
  UserController.uploadPhoto
);
app.post(
  "/uploadCompanyPhoto/:id",
  upload.single("photo"),
  UserController.uploadCompanyPhoto
);
app.post("/setRole", UserController.setRole);
app.post("/saveName", UserController.changeUserName);
app.get("/getUsers", UserController.getUsers);

app.get("/getShippingCalculation", getShippingCalculation);

// Маршруты для обновления информации о компании
app.post("/updateCompany", UserController.updateCompany);
app.get("/getCompany/:id", UserController.getCompany);

// Маршрут для сохранения темы/языка
app.post("/saveTheme", UserController.saveTheme);
app.post("/saveLang", UserController.saveLanguage);

app.get("/api/distance", getDistance);

app.use("/api/rating", ratingRouter);

// ---------- Маршруты для заказов (Legacy + New) ----------
app.post("/orders", OrderController.createOrder);
app.get("/orders", OrderController.getOrders);
app.get("/allOrders", OrderController.getAllOrders);
app.put("/orders/:id", OrderController.updateOrder);
app.delete("/orders", OrderController.deleteOrder);
app.post("/orders/archive", OrderController.archiveOrder);
app.post("/orders/restore", OrderController.restoreOrder);

// --- Bidding Engine ---
app.get("/api/v1/orders/:id", OrderController.getOrderById);
app.post("/api/v1/orders/:orderId/bids", OrderController.placeBid);
app.post("/api/v1/orders/:orderId/bids/:bidId/accept", OrderController.acceptBid);

// --- Fleet Management ---
app.get("/api/v1/fleet/locations", FleetController.getFleetLocations);
app.post("/api/v1/fleet/vehicles", FleetController.addVehicle);
app.get("/api/v1/fleet/vehicles", FleetController.getMyFleet);
app.post("/api/v1/fleet/vehicles/assign-driver", FleetController.assignDriverToVehicle);
app.post("/api/v1/fleet/drivers", FleetController.addDriverByTelegramId);
app.get("/api/v1/fleet/drivers", FleetController.getMyDrivers);
app.patch("/api/v1/orders/:orderId/assign", OrderController.assignDriver);

// --- Driver Workflow ---
app.patch("/api/v1/driver/orders/:orderId/status", OrderController.updateDriverStatus);
app.post("/api/v1/driver/orders/:orderId/pod", upload.array("photos", 5), OrderController.uploadPoD);
app.get("/api/v1/orders/:orderId/receipt-qr", OrderController.generateReceiptQR);
app.post("/api/v1/orders/:orderId/confirm-receipt", OrderController.confirmReceipt);

// --- AI Module ---
app.post("/api/v1/ai/parse", AIController.parseOrder);


// --- Search ---
app.get("/api/v1/users/telegram/:telegramId", SearchController.getUserByTelegramId);

// ---------- Маршруты для парсинга ----------
// app.get("/parse-cargo", ParseController.parseAvtodispetcher);
// app.get("/parse-vehicles", ParseController.parseVehiclesFromAvtodispetcher);

// ---------- AI Service Route (Legacy) ----------
app.post("/api/ai/parse-order", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "Text is required" });
    
    const result = await parseOrderRequest(text);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Пример защищенного маршрута (только для логистов и админов)
app.get("/api/logistician/dashboard", checkRole(['logistician', 'admin']), (req, res) => {
  res.json({ message: "Welcome to logistician dashboard", user: req.user });
});

app.post("/support", sendSupportMessage);

// ======================= ROBOKASSA (без Order) =======================
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

// срок действия подписки по плану
function calcExpiry(plan) {
  const now = new Date();
  const expires = new Date(now.getTime());
  switch (plan) {
    case "single": // 1 неделя
      expires.setDate(expires.getDate() + 7);
      break;
    case "minimal": // 1 месяц
      expires.setMonth(expires.getMonth() + 1);
      break;
    case "standard-3m": // 3 месяца
      expires.setMonth(expires.getMonth() + 3);
      break;
    case "standard-12m": // 12 месяцев
      expires.setMonth(expires.getMonth() + 12);
      break;
    default: // fallback — 1 неделя
      expires.setDate(expires.getDate() + 7);
  }
  return { startedAt: now, expiresAt: expires };
}

/**
 * Генерация ссылки на оплату Premium
 * POST /api/payments/robokassa/create
 * body: { userId: string, amount: number|string, plan?: "single"|"minimal"|"standard-3m"|"standard-12m" }
 */
app.post("/api/payments/robokassa/create", async (req, res) => {
  try {
    const { userId, amount, plan } = req.body || {};
    if (!userId || amount === undefined || amount === null) {
      return res.status(400).json({ error: "userId and amount required" });
    }

    // проверим, что пользователь существует
    const user = await User.findById(userId).select("_id");
    if (!user) return res.status(404).json({ error: "user not found" });

    const { ROBO_LOGIN, ROBO_PASS1, ROBO_IS_TEST } = process.env;
    if (!ROBO_LOGIN || !ROBO_PASS1) {
      return res.status(500).json({ error: "Robokassa env is not configured" });
    }

    const InvId = String(Date.now());
    const OutSum = Number(amount).toFixed(2);

    // Shp_* вернутся в колбэк
    const shp = {
      Shp_user: String(userId),
      ...(plan ? { Shp_plan: String(plan) } : {}),
    };
    const shpSorted = Object.entries(shp).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    const shpQuery = shpSorted.map(([k, v]) => `${k}=${v}`).join(":");

    // Подпись инициации: MerchantLogin:OutSum:InvId:Password1[:Shp_...]
    const signBase =
      `${ROBO_LOGIN}:${OutSum}:${InvId}:${ROBO_PASS1}` +
      (shpQuery ? `:${shpQuery}` : "");
    const SignatureValue = md5(signBase);

    const params = new URLSearchParams({
      MerchantLogin: ROBO_LOGIN,
      OutSum,
      InvId,
      SignatureValue,
      Description: `Оплата Premium`,
      Encoding: "utf-8",
    });
    if (ROBO_IS_TEST === "1") params.set("IsTest", "1");
    for (const [k, v] of shpSorted) params.set(k, v);

    const payUrl = `https://auth.robokassa.ru/Merchant/Index.aspx?${params.toString()}`;
    return res.json({ payUrl });
  } catch (e) {
    console.error("create robokassa payment error:", e);
    return res.status(500).json({ error: "internal error" });
  }
});

/**
 * Серверный колбэк (Result URL)
 * POST /api/payments/robokassa/callback
 * content-type: application/x-www-form-urlencoded
 * На успех — строго: OK<InvId>
 */
app.post("/api/payments/robokassa/callback", async (req, res) => {
  try {
    const { OutSum, InvId, SignatureValue, Shp_user, Shp_plan, ...rest } =
      req.body || {};
    if (!OutSum || !InvId || !SignatureValue) {
      return res.status(400).send("bad request");
    }

    const { ROBO_PASS2 } = process.env;
    if (!ROBO_PASS2) return res.status(500).send("server misconfigured");

    // Собираем Shp_* для подписи, сортируем по имени
    const shpEntries = Object.entries({ Shp_user, Shp_plan, ...rest })
      .filter(
        ([k, v]) => k && k.startsWith("Shp_") && v !== undefined && v !== null
      )
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`);
    const shpQuery = shpEntries.join(":");

    // Проверка подписи: OutSum:InvId:Password2[:Shp_...]
    const base =
      `${OutSum}:${InvId}:${ROBO_PASS2}` + (shpQuery ? `:${shpQuery}` : "");
    const mySign = md5(base);
    if (mySign.toLowerCase() !== String(SignatureValue).toLowerCase()) {
      return res.status(400).send("bad sign");
    }

    // Активируем подписку пользователю
    if (Shp_user) {
      const user = await User.findById(Shp_user);
      if (user) {
        const plan = Shp_plan || "single";
        const { startedAt, expiresAt } = calcExpiry(plan);

        user.subscription = {
          plan,
          startedAt,
          expiresAt,
          status: "active",
        };
        // обратная совместимость
        user.isPremium = true;

        await user.save();
      }
    }

    return res.send("OK" + InvId);
  } catch (e) {
    console.error("robokassa callback error:", e);
    return res.status(500).send("error");
  }
});

// Отмена подписки
app.post("/api/subscription/cancel", async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId)
      return res.status(400).json({ success: false, error: "userId required" });

    const user = await User.findById(userId);
    if (!user)
      return res.status(404).json({ success: false, error: "user not found" });

    user.subscription = {
      plan: "none",
      startedAt: null,
      expiresAt: null,
      status: "inactive",
    };
    user.isPremium = false;

    await user.save();
    return res.json({ success: true });
  } catch (e) {
    console.error("cancel subscription error:", e);
    return res.status(500).json({ success: false, error: "internal error" });
  }
});
// ===================== /ROBOKASSA =======================

const port = process.env.PORT || 5050;

server.listen(port, async () => {
  console.log(successMsg("listening port:", port));

  // // Стартуем Telegram-бота
  // try {
  //   await startBot();
  //   console.log(successMsg("Telegram-бот успешно запущен"));
  // } catch (err) {
  //   console.error(errorMsg("Ошибка при запуске Telegram-бота:"), err);
  // }

  // // Стартуем Telegram MTProto парсер
  // try {
  //   await startTelegramListener();
  //   console.log(successMsg("Telegram-парсер успешно запущен"));
  // } catch (err) {
  //   console.error(errorMsg("Ошибка при запуске Telegram-парсера:"), err);
  // }
});
