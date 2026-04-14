import mongoose from "mongoose";

// ------------------ Счётчик для orderNumber ------------------
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

// Проверяем, существует ли модель, чтобы избежать ошибки перезаписи при хот-релоаде
const Counter = mongoose.models.Counter || mongoose.model("Counter", counterSchema);

// ------------------ Sub-schemas ------------------

// История ставок (Торги)
const bidSchema = new mongoose.Schema({
  logistician: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  amount: { type: Number, required: true },
  currency: { type: String, default: "RUB" },
  comment: { type: String },
  status: { 
    type: String, 
    enum: ["PENDING", "ACCEPTED", "REJECTED", "COUNTER_OFFER"],
    default: "PENDING" 
  },
  createdAt: { type: Date, default: Date.now }
}, { _id: true });

// Данные от AI Парсера
const aiAnalysisSchema = new mongoose.Schema({
  originalText: String,
  detectedCargo: {
    type: String,
    weight: Number, // кг
    volume: Number, // м3
    dangerClass: String
  },
  recommendedVehicleType: String,
  estimatedPrice: {
    min: Number,
    max: Number,
    currency: { type: String, default: "RUB" }
  },
  confidenceScore: Number, // 0-1
  parsedAt: { type: Date, default: Date.now }
}, { _id: false });

// Точка маршрута
const locationPointSchema = new mongoose.Schema({
  address: { type: String, required: true },
  city: String,
  coordinates: {
    lat: Number,
    lng: Number
  },
  plannedTime: Date,
  actualTime: Date,
  contactPerson: {
    name: String,
    phone: String
  }
}, { _id: false });

// Proof of Delivery (Фотоотчет)
const podSchema = new mongoose.Schema({
  photos: [String], // URL s3
  signature: String, // URL или base64
  documents: [String], // Скан ТТН
  comment: String,
  submittedAt: { type: Date, default: Date.now },
  verifiedByCustomer: { type: Boolean, default: false }
}, { _id: false });

// ------------------ Основная схема заказа ------------------
const options = { discriminatorKey: "orderType", timestamps: true };

const orderSchema = new mongoose.Schema(
  {
    orderNumber: {
      type: Number,
      unique: true,
      index: true,
    },
    
    // Кто создал (Заказчик)
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false, // Make optional for legacy parser
      index: true
    },
    
    // Legacy field support for parser
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: false,
    },
    source: { type: String, default: "manual" },

    // Основной статус (State Machine)
    status: {
      type: String,
      enum: [
        "DRAFT",          // Черновик (после парсинга)
        "PUBLISHED",      // Опубликован, ждет ставок (PENDING_BID)
        "NEGOTIATION",    // Идут торги
        "APPROVED",       // Исполнитель выбран, цена зафиксирована
        "ASSIGNED",       // Назначена машина и водитель
        "AT_PICKUP",      // Водитель прибыл на погрузку
        "IN_TRANSIT",     // Груз в пути
        "AT_DROP",        // Водитель прибыл на выгрузку
        "DELIVERED",      // Груз сдан, PoD загружен
        "COMPLETED",      // Заказ закрыт и оплачен
        "CANCELED"        // Отменен
      ],
      default: "DRAFT",
      index: true
    },

    // Маршрут (New)
    route: {
      from: { type: locationPointSchema, required: false },
      to: { type: locationPointSchema, required: false },
      waypoints: [locationPointSchema] // Промежуточные точки
    },

    // Груз (New) - Renamed to avoid conflict with legacy String field
    cargoDetails: {
      description: { type: String, required: false },
      weight: { type: Number, required: false }, // кг
      volume: Number, // м3
      pallets: Number,
      requiresTempControl: { type: Boolean, default: false }, // Реф
      temperature: { min: Number, max: Number },
      isFragile: { type: Boolean, default: false },
      requiresLoader: { type: Boolean, default: false } // Грузчики
    },

    // Финансы
    pricing: {
      customerOffer: Number,    // Желаемая цена заказчика
      finalPrice: Number,       // Итоговая согласованная цена
      currency: { type: String, default: "RUB" },
      paymentMethod: { type: String, enum: ["CASH", "CARD", "INVOICE"], default: "CASH" },
      isPaid: { type: Boolean, default: false }
    },

    // Торги
    bids: [bidSchema],

    // Исполнение
    executor: {
      logistician: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // Выбранный логист
      vehicle: { type: mongoose.Schema.Types.ObjectId, ref: "Vehicle" },  // Назначенная машина
      driver: { type: mongoose.Schema.Types.ObjectId, ref: "User" }       // Назначенный водитель
    },

    // AI Аналитика
    aiAnalysis: aiAnalysisSchema,

    // Подтверждение доставки
    proofOfDelivery: podSchema,
    receiptToken: { type: String },

    // История координат (сбрасывается из Redis)
    trackHistory: [
      {
        lat: Number,
        lng: Number,
        speed: Number,
        timestamp: { type: Date, default: Date.now }
      }
    ],

    isArchived: { type: Boolean, default: false },
  },
  options
);

// Индексы для быстрого поиска
orderSchema.index({ "route.from.city": 1 });
orderSchema.index({ "route.to.city": 1 });
orderSchema.index({ createdAt: -1 });

// Автоинкремент orderNumber
orderSchema.pre("save", async function (next) {
  if (this.isNew && !this.orderNumber) {
    try {
      const counter = await Counter.findByIdAndUpdate(
        { _id: "orderId" },
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
      );
      this.orderNumber = counter.seq;
    } catch (err) {
      return next(err);
    }
  }
  next();
});

export const Order = mongoose.model("Order", orderSchema);

// ------------------ Legacy Discriminators ------------------

// Схема для грузов (CargoOrder) - Legacy support
const CargoOrderSchema = new mongoose.Schema({
  from: { type: String, required: false },
  to: { type: String, required: false },
  cargo: { type: String, required: false }, // Legacy string field
  weight: { type: String, required: false },
  volume: { type: String, required: false },
  rate: { type: String, required: false },
  ready: { type: String, required: false },
  vehicle: { type: String, required: false }, // Legacy string field
  telefon: { type: String, required: false },
  isFragile: { type: Boolean, default: false },
  loadersRequired: { type: Boolean, default: false },
  estimatedPriceFactor: { type: Number, default: 1.0 },
});

export const CargoOrder = Order.discriminator("CargoOrder", CargoOrderSchema);

// Схема для машин (MachineOrder) - Legacy support
const MachineOrderSchema = new mongoose.Schema({
  url: { type: String, required: false },
  marka: { type: String, required: false },
  tip: { type: String, required: false },
  kuzov: { type: String, required: false },
  tip_zagruzki: { type: String, required: false },
  gruzopodyomnost: { type: String, required: false },
  vmestimost: { type: String, required: false },
  data_gotovnosti: { type: String, required: false },
  otkuda: { type: String, required: false },
  kuda: { type: String, required: false },
  telefon: { type: String, required: false },
  imya: { type: String, required: false },
  firma: { type: String, required: false },
  gorod: { type: String, required: false },
  pochta: { type: String, required: false },
  company: { type: String, required: false },
});

export const MachineOrder = Order.discriminator("MachineOrder", MachineOrderSchema);
