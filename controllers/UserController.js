import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

import User from "../models/User.js"; // Убедитесь, что путь правильный
import sharp from "sharp";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import mongoose from "mongoose";

import dotenv from "dotenv";
dotenv.config();

const bucketName = process.env.BUCKET_NAME;
const bucketRegion = process.env.BUCKET_REGION;
const accessKey = process.env.BUCKET_ACCESS_KEY;
const secretAccessKey = process.env.BUCKET_SECRET_ACCESS_KEY;

console.log(bucketName, bucketRegion, accessKey, secretAccessKey);

const s3 = new S3Client({
  credentials: {
    accessKeyId: accessKey,
    secretAccessKey: secretAccessKey,
  },
  region: bucketRegion,
});

export const register = async (req, res) => {
  try {
    const { email, name, password, role } = req.body;

    if (!email || !name || !password || !role) {
      return res
        .status(400)
        .json({ message: "name, email, password и role обязательны" });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res
        .status(409)
        .json({ message: "Пользователь с таким email уже существует" });
    }

    // Хэширование пароля
    const salt = await bcrypt.genSalt(10); // Генерация соли
    const hashedPassword = await bcrypt.hash(password, salt); // Хэширование пароля

    // Создание нового пользователя
    const newUser = new User({
      email,
      name,
      password: hashedPassword, // Используем хэшированный пароль
      role,
      // В базе есть старый unique-index telegramId_1. Для email-регистрации
      // задаем стабильное уникальное значение, чтобы Mongo не считал его null.
      telegramId: req.body.telegramId || `email:${email}`,
    });

    // Сохранение пользователя в базе данных
    const savedUser = await newUser.save();

    // Генерация токена
    const token = jwt.sign({ _id: savedUser._id }, "secret123", {
      expiresIn: "30d",
    });

    // Ответ клиенту
    const { password: _password, ...userData } = savedUser._doc;
    res.json({ token, ...userData });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Не удалось зарегистрироваться" });
  }
};

export const login = async (req, res) => {
  try {
    // Поиск пользователя по email
    const user = await User.findOne({ email: req.body.email });

    if (!user) {
      return res.status(404).json({ message: "Пользователь не найден" });
    }

    // Проверка пароля
    const isPasswordValid = await bcrypt.compare(
      req.body.password,
      user.password,
    );

    if (!isPasswordValid) {
      return res.status(400).json({ message: "Неверный логин или пароль" });
    }

    // Генерация JWT
    const token = jwt.sign({ _id: user._id }, "secret123", {
      expiresIn: "30d",
    });

    // Возвращаем данные пользователя без пароля
    const { password, ...userData } = user._doc;
    res.json({ token, ...userData });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Не удалось войти в аккаунт" });
  }
};

export const getUsers = async (req, res) => {
  const users = await User.find();
  if (users) {
    res.json(users);
  } else {
    res.status(404).json({ message: "error" });
  }
};

// export const updateUserInfo = async (req, res) => {
//   try {
//     const userId = req.params.id;
//     const { city, country, job, oblast } = req.body;

//     const updatedUser = await User.findByIdAndUpdate(
//       userId,
//       { city, country, job, oblast }, // Обновляемые поля
//       { new: true } // Возвращаем обновленный объект
//     );

//     if (!updatedUser) {
//       return res.status(404).json({ message: 'Пользователь не найден' });
//     }

//     res.json({ message: 'Информация обновлена', user: updatedUser });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ message: 'Не удалось обновить информацию' });
//   }
// };

export const getSubscribe = async (req, res) => {
  try {
    const { type, val } = req.body;
    const user = await User.findOne({ _id: req.body.id });

    if (!user) {
      return res.status(404).json({ message: "Пользователь не найден" });
    }

    if (Array.isArray(type)) {
      type.forEach((t) => {
        user[t] = val;
      });
    } else {
      user[type] = val;
    }

    await user.save();
    return res
      .status(200)
      .json({ message: "Подписка успешно оформлена", user });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Не удалось оформить подписку" });
  }
};

export const setRole = async (req, res) => {
  const { userId, role } = req.body;
  console.log("setRole body:", req.body);

  if (!userId || !role) {
    return res.status(400).json({ error: "User ID и роль обязательны" });
  }

  try {
    const user = await User.findByIdAndUpdate(
      userId,
      { role },
      { new: true, runValidators: false },
    );
    if (!user) {
      return res.status(404).json({ error: "Пользователь не найден" });
    }
    return res.json({ status: "Роль обновлена", user });
  } catch (error) {
    console.error("Ошибка при обновлении роли:", error);
    return res
      .status(500)
      .json({ error: "Ошибка сервера при обновлении роли" });
  }
};

export const getUser = async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.params.id });

    if (user) {
      if (user.avatar && user.avatar.slice(0, 12) != "https://t.me") {
        // Генерируем временную ссылку для доступа к аватару
        const getObjectParams = {
          Bucket: bucketName,
          Key: user.avatar,
        };

        const command = new GetObjectCommand(getObjectParams);
        const avatarUrl = await getSignedUrl(s3, command, { expiresIn: 3600 }); // Срок действия ссылки — 1 час

        // Включаем ссылку на аватар в ответ
        const userWithAvatarUrl = { ...user._doc, avatar: avatarUrl };

        res.json(userWithAvatarUrl);
      } else {
        // Если аватар отсутствует, возвращаем пользователя без изменений
        res.json(user);
      }
    } else {
      return res.status(404).json({ message: "Пользователь не найден" });
    }
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "Не удалось получить данные пользователя" });
  }
};

export const uploadPhoto = async (req, res) => {
  const userId = req.params.id;

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return res.status(400).json({ error: "Некорректные параметры" });
  }

  try {
    const user = await User.findOne({ _id: userId });
    if (!user) {
      return res.status(404).json({ error: "Пользователь не найден" });
    }

    // Upload file to S3
    const buffer = await sharp(req.file.buffer).toBuffer();
    const imageName = `${userId}_${Date.now()}`;

    const params = {
      Bucket: bucketName,
      Key: imageName,
      Body: buffer,
      ContentType: req.file.mimetype,
    };

    const command = new PutObjectCommand(params);
    await s3.send(command);

    // Update the user's photo field
    user.avatar = imageName;
    await user.save();

    res.json({ message: "Фото успешно загружено", user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Ошибка при загрузке фото" });
  }
};

export const changeUserName = async (req, res) => {
  try {
    const { name, userId } = req.body;

    if (!name) {
      return res.status(400).json({ message: "Необходимо указать name" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "Пользователь не найден" });
    }

    user.name = name;
    await user.save();
    return res
      .status(200)
      .json({ message: "План тренировок успешно сохранен", user });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Не удалось сохранить имя" });
  }
};

export const updateCompany = async (req, res) => {
  try {
    const { userId, ...companyData } = req.body;
    if (!userId) {
      return res.status(400).json({ error: "Необходимо передать userId" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: "Пользователь не найден" });
    }

    // companyData может содержать любые поля из [inn, ogrn, profile, country, city, email, website, manager, phone, jobTitle, department]
    // Делаем частичное слияние
    Object.keys(companyData).forEach((key) => {
      // Если в теле есть какое-то поле, обновляем его у user.company
      user.company[key] = companyData[key];
    });

    await user.save();
    return res.json({ status: "Информация о компании обновлена", user });
  } catch (error) {
    console.error("Ошибка при обновлении информации о компании:", error);
    return res
      .status(500)
      .json({ error: "Ошибка сервера при обновлении информации о компании" });
  }
};

export const getCompany = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ message: "Пользователь не найден" });
    }

    const company = user.company?.toObject?.() || user.company || {};

    if (company.photo && !company.photo.startsWith("http")) {
      const getObjectParams = {
        Bucket: bucketName,
        Key: company.photo,
      };

      const command = new GetObjectCommand(getObjectParams);
      const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

      company.photo = signedUrl;
    }

    res.json({ company });
  } catch (error) {
    console.error("Ошибка при получении компании:", error);
    res.status(500).json({ message: "Не удалось получить данные компании" });
  }
};

export const saveTheme = async (req, res) => {
  const { userId, theme } = req.body;

  // Проверка входных данных
  if (!userId || !theme) {
    return res.status(400).json({ message: "userId и theme обязательны" });
  }

  if (!["light", "dark"].includes(theme)) {
    return res.status(400).json({ message: "Неверное значение темы" });
  }

  try {
    const user = await User.findByIdAndUpdate(
      userId,
      { theme },
      { new: true, runValidators: false },
    );
    if (!user) {
      return res.status(404).json({ message: "Пользователь не найден" });
    }

    res.json({ message: "Тема успешно сохранена", user });
  } catch (error) {
    console.error("Ошибка при сохранении темы:", error);
    res.status(500).json({ message: "Ошибка сервера при сохранении темы" });
  }
};

export const saveLanguage = async (req, res) => {
  const { userId, language } = req.body;

  if (!userId || !language) {
    return res.status(400).json({ message: "userId и language обязательны" });
  }

  try {
    const user = await User.findByIdAndUpdate(
      userId,
      { language },
      { new: true, runValidators: false },
    );
    if (!user) {
      return res.status(404).json({ message: "Пользователь не найден" });
    }

    res.json({ message: "Язык успешно сохранён", user });
  } catch (error) {
    console.error("Ошибка при сохранении языка:", error);
    res.status(500).json({ message: "Ошибка сервера при сохранении языка" });
  }
};

export const uploadCompanyPhoto = async (req, res) => {
  const userId = req.params.id;

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return res.status(400).json({ error: "Некорректные параметры" });
  }

  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: "Пользователь не найден" });
    }

    const buffer = await sharp(req.file.buffer).toBuffer();
    const imageName = `company_${userId}_${Date.now()}`;

    const params = {
      Bucket: bucketName,
      Key: imageName,
      Body: buffer,
      ContentType: req.file.mimetype,
    };

    const command = new PutObjectCommand(params);
    await s3.send(command);

    if (!user.company) user.company = {};
    user.company.photo = imageName;
    await user.save();

    res.json({ message: "Фото компании успешно загружено", user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Ошибка при загрузке фото компании" });
  }
};

export const saveLocation = async (req, res) => {
  const { userId, location } = req.body;

  if (!userId || !location || !location.latitude || !location.longitude) {
    return res.status(400).json({ message: "userId и координаты обязательны" });
  }

  try {
    const nextLocation = {
      latitude: location.latitude,
      longitude: location.longitude,
      updatedAt: new Date(),
      heading: location.heading,
      speed: location.speed,
    };

    const user = await User.findByIdAndUpdate(
      userId,
      { location: nextLocation },
      { new: true, runValidators: false },
    );
    if (!user)
      return res.status(404).json({ message: "Пользователь не найден" });

    res.json({
      message: "Координаты успешно сохранены",
      location: user.location,
    });
  } catch (error) {
    console.error("Ошибка при сохранении координат:", error);
    res
      .status(500)
      .json({ message: "Ошибка сервера при сохранении координат" });
  }
};
