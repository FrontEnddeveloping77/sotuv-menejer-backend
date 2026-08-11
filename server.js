require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jwt-simple');

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

app.get('/api/health', (req, res) => {
    res.send('Backend Server muvaffaqiyatli ishlayapti!');
});

// ----------------------------------------------------
// 2. LOGIN ENDPOINT (Xatosiz variant)
// ----------------------------------------------------
app.post('/api/login', async (req, res) => {
    const { login, password } = req.body;

    if (!login || !password) {
        return res.status(400).json({ message: "Login va parol kiritilishi shart!" });
    }

    try {
        // SELECT * orqali barcha mavjud ustunlarni olamiz (yo'q ustun bo'yicha xato bermaydi)
        const userResult = await pool.query(
            `SELECT * FROM public.users WHERE site_login = $1`,
            [login.trim()]
        );

        if (userResult.rows.length === 0) {
            return res.status(400).json({ message: "Login yoki parol noto‘g‘ri!" });
        }

        const user = userResult.rows[0];

        if (!user.is_paid) {
            return res.status(403).json({
                message: "Obunangiz faol emas! Iltimos, Telegram bot orqali obunani yangilang."
            });
        }

        const cleanPassword = password.trim();
        let isPasswordValid = false;

        // Bazada qaysi parol ustuni mavjud bo'lsa, o'shani avtomatik aniqlaymiz
        const dbPassword = user.site_password_hash || user.site_password || user.password;

        if (dbPassword) {
            // 1. Bcrypt hash bo'lsa
            if (dbPassword.startsWith('$2a$') || dbPassword.startsWith('$2b$')) {
                try {
                    isPasswordValid = await bcrypt.compare(cleanPassword, dbPassword);
                } catch (e) {
                    isPasswordValid = false;
                }
            } else {
                // 2. Oddiy matn (plain text) bo'lsa
                if (cleanPassword === dbPassword.trim()) {
                    isPasswordValid = true;
                }
            }
        }

        if (!isPasswordValid) {
            return res.status(400).json({ message: "Login yoki parol noto‘g‘ri!" });
        }

        // Token yaratish
        const payload = {
            userId: user.id,
            telegramId: user.telegram_id,
            login: user.site_login,
            exp: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60)
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
        console.error('Login xatosi:', err);
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
// 5. SAFE ROUTE FALLBACK (Render Crash Fix)
// ----------------------------------------------------
app.use((req, res) => {
    res.status(404).json({ message: "Bunday yo'nalish topilmadi" });
});

// ----------------------------------------------------
// SERVERNI ISHGA TUSHIRISH
// ----------------------------------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Backend Server ${PORT}-portda ishga tushdi`);
});