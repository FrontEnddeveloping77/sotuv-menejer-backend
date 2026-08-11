require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// PostgreSQL (Supabase) DB Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// JWT Token tekshirish middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ message: "Token taqdim etilmadi!" });
    }

    jwt.verify(token, process.env.JWT_SECRET || 'secret_key', (err, user) => {
        if (err) {
            return res.status(403).json({ message: "Token yaroqsiz yoki muddati o'tgan!" });
        }
        req.user = user;
        next();
    });
};

// ----------------------------------------------------
// 1. LOGIN ENDPOINT (POST /api/login)
// ----------------------------------------------------
app.post('/api/login', async (req, res) => {
    const { login, password } = req.body;

    if (!login || !password) {
        return res.status(400).json({ message: "Login va parol kiritilishi shart!" });
    }

    try {
        const userResult = await pool.query(
            `SELECT * FROM public.users WHERE site_login = $1`,
            [login.trim()]
        );

        if (userResult.rows.length === 0) {
            return res.status(400).json({ message: "Login yoki parol noto‘g‘ri!" });
        }

        const user = userResult.rows[0];

        if (password !== user.site_password_hash && password !== user.site_password) {
            return res.status(400).json({ message: "Login yoki parol noto‘g‘ri!" });
        }

        if (!user.is_paid) {
            return res.status(403).json({ message: "Hisobingiz faollashtirilmagan yoki obuna muddati tugagan!" });
        }

        const token = jwt.sign(
            { userId: user.id, site_login: user.site_login },
            process.env.JWT_SECRET || 'secret_key',
            { expiresIn: '24h' }
        );

        return res.json({
            message: "Tizimga muvaffaqiyatli kirildi!",
            token,
            user: {
                id: user.id,
                full_name: user.full_name,
                username: user.username,
                site_login: user.site_login
            }
        });
    } catch (err) {
        console.error('Login xatosi:', err);
        return res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
    }
});

// ----------------------------------------------------
// 2. USER PROFILE ENDPOINT (GET /api/me)
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
        console.error('User profile xatosi (/api/me):', err);
        return res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
    }
});

// ----------------------------------------------------
// 3. STATISTIKA ENDPOINTI (GET /api/stats)
// ----------------------------------------------------
app.get('/api/stats', authenticateToken, async (req, res) => {
    try {
        const stats = await pool.query(
            `SELECT 
                COUNT(*) as "totalProducts",
                COALESCE(SUM(quantity), 0) as "totalStock"
             FROM public.products 
             WHERE user_id = $1`,
            [req.user.userId]
        );

        return res.json({
            totalProducts: Number(stats.rows[0].totalProducts || 0),
            totalStock: Number(stats.rows[0].totalStock || 0),
            totalSold: 0
        });
    } catch (err) {
        console.error('Stats xatosi:', err);
        return res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
    }
});

// ----------------------------------------------------
// 4. TOVAR QO'SHISH ENDPOINTI (POST /api/products)
// ----------------------------------------------------
app.post('/api/products', authenticateToken, async (req, res) => {
    const { category, name, cost_price, color, size, quantity } = req.body;

    if (!name || cost_price === undefined) {
        return res.status(400).json({ message: "Tovar nomi va kelgan narxi kiritilishi shart!" });
    }

    try {
        const newProduct = await pool.query(
            `INSERT INTO public.products (user_id, category, name, cost_price, color, size, quantity)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [
                req.user.userId,
                category || null,
                name.trim(),
                Number(cost_price),
                color || null,
                size || null,
                Number(quantity) || 0
            ]
        );

        return res.status(201).json({
            message: "Tovar muvaffaqiyatli qo'shildi",
            product: newProduct.rows[0]
        });
    } catch (err) {
        console.error('Tovar qo\'shishda xatolik:', err);
        return res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
    }
});

// ----------------------------------------------------
// 5. TOVARLAR RO'YXATINI OLISH (GET /api/products)
// ----------------------------------------------------
app.get('/api/products', authenticateToken, async (req, res) => {
    try {
        const products = await pool.query(
            `SELECT * FROM public.products WHERE user_id = $1 ORDER BY id DESC`,
            [req.user.userId]
        );

        return res.json({ products: products.rows });
    } catch (err) {
        console.error('Tovarlarni olishda xatolik:', err);
        return res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
    }
});

// ----------------------------------------------------
// 6. SAFE ROUTE FALLBACK (404 Error handler)
// ----------------------------------------------------
app.use((req, res) => {
    res.status(404).json({ message: "Bunday yo'nalish topilmadi" });
});

// SERVERNI ISHGA TUSHIRISH
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Backend Server ${PORT}-portda ishga tushdi`);
});