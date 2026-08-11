require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jwt-simple'); // yoki require('jsonwebtoken')

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Dynamic SSL cert verification ni o'chirish (Render + Supabase uchun zarur)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// PostgreSQL (Supabase) ulanishi
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_123';

// ----------------------------------------------------
// 1. HEALTH CHECK ENDPOINT
// ----------------------------------------------------
app.get('/', (req, res) => {
    res.send('Backend Server muvaffaqiyatli ishlayapti!');
});

// ----------------------------------------------------
// 2. LOGIN ENDPOINT (Saytga kirish)
// ----------------------------------------------------
app.post('/api/login', async (req, res) => {
    const { login, password } = req.body;

    if (!login || !password) {
        return res.status(400).json({ message: "Login va parol kiritilishi shart!" });
    }

    try {
        // Bazadan foydalanuvchini site_login bo'yicha qidiramiz
        const userResult = await pool.query(
            `SELECT id, telegram_id, site_login, site_password_hash, is_paid, expires_at 
             FROM public.users 
             WHERE site_login = $1`,
            [login.trim()]
        );

        if (userResult.rows.length === 0) {
            return res.status(400).json({ message: "Login yoki parol noto‘g‘ri!" });
        }

        const user = userResult.rows[0];

        // 1. Obuna holatini tekshirish
        if (!user.is_paid) {
            return res.status(403).json({ 
                message: "Obunangiz faol emas! Iltimos, Telegram bot orqali obunani yangilang." 
            });
        }

        // 2. Parolni tekshirish (site_password_hash / bcrypt)
        if (!user.site_password_hash) {
            return res.status(400).json({ message: "Login yoki parol noto‘g‘ri!" });
        }

        const isPasswordValid = await bcrypt.compare(password, user.site_password_hash);

        if (!isPasswordValid) {
            return res.status(400).json({ message: "Login yoki parol noto‘g‘ri!" });
        }

        // 3. Autentifikatsiya tokeni yaratish (JWT)
        const payload = {
            userId: user.id,
            telegramId: user.telegram_id,
            login: user.site_login,
            exp: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60) // 7 kun
        };

        const token = jwt.encode(payload, JWT_SECRET);

        return res.json({
            message: "Tizimga muvaffaqiyatli kirildi",
            token,
            user: {
                id: user.id,
                telegram_id: user.telegram_id,
                login: user.site_login
            }
        });

    } catch (err) {
        console.error('Server xatosi (Login):', err);
        return res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
    }
});

// ----------------------------------------------------
// 3. AUTH MIDDLEWARE (Himoyalangan marshrutlar uchun)
// ----------------------------------------------------
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ message: "Avtorizatsiyadan o'tilmagan!" });
    }

    try {
        const decoded = jwt.decode(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(403).json({ message: "Yaroqsiz yoki muddati o'tgan token!" });
    }
};

// ----------------------------------------------------
// 4. USER PROFILE / ME ENDPOINT
// ----------------------------------------------------
app.get('/api/me', authenticateToken, async (req, res) => {
    try {
        const userResult = await pool.query(
            `SELECT id, telegram_id, full_name, username, site_login, is_paid, expires_at 
             FROM public.users 
             WHERE id = $1`,
            [req.user.userId]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: "Foydalanuvchi topilmadi!" });
        }

        return res.json({ user: userResult.rows[0] });
    } catch (err) {
        console.error('Server xatosi (/api/me):', err);
        return res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
    }
});

// ----------------------------------------------------
// SERVERNI ISHGA TUSHRISH
// ----------------------------------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Backend Server ${PORT}-portda ishga tushdi`);
});F