// 1. Eng tepasiga qo'shing (SSL sertifikat tekshiruvini majburiy o'chirish)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_maxfiy_kalit_123!';

// Express Middleware va CORS
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// PostgreSQL Baza Sozlamalari
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:a2012a@localhost:5432/mybot_db',
    ssl: {
        rejectUnauthorized: false
    }
});

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_maxfiy_kalit_123!';

// Express Middleware va CORS ni to'liq ochiq qilish
app.use(cors({
    origin: '*', // Barcha domenlardan keladigan so'rovlarga ruxsat berish
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// 1. PostgreSQL Baza Sozlamalari (SSL xatosini tuzatish)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:a2012a@localhost:5432/mybot_db',
    ssl: {
        rejectUnauthorized: false
    }
});

// Baza ulanish xatosidan server o'chib qolmasligi uchun catch handler
pool.on('error', (err) => {
    console.error('Kutilmagan PostgreSQL xatosi:', err);
});

app.set('pool', pool);

// ------------------- API MARSHRUTLARI ------------------- //

// Health check endpoint (Render va brauzer tekshiruvi uchun)
app.get('/', (req, res) => {
    res.send('Backend server muvaffaqiyatli ishlamoqda!');
});

// JWT Tokenni tekshirish uchun Middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ message: 'Token topilmadi, ruxsat berilmadi!' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ message: 'Token yaroqsiz yoki muddati o‘tgan!' });
        }
        req.user = user;
        next();
    });
};

// 2. LOGIN API
const handleLogin = async (req, res) => {
    const loginInput = req.body.username || req.body.login;
    const passwordInput = req.body.password;

    if (!loginInput || !passwordInput) {
        return res.status(400).json({ message: 'Login va parol kiritilishi shart!' });
    }

    try {
        const userResult = await pool.query(
            'SELECT id, telegram_id, site_login, site_password_hash, is_paid, expires_at FROM public.users WHERE site_login = $1',
            [loginInput]
        );

        if (userResult.rows.length === 0) {
            return res.status(400).json({ message: 'Login yoki parol noto‘g‘ri!' });
        }

        const user = userResult.rows[0];

        if (!user.is_paid) {
            return res.status(403).json({ message: 'Obunangiz faol emas!' });
        }

        if (user.expires_at) {
            const currentDate = new Date();
            const expirationDate = new Date(user.expires_at);

            if (currentDate > expirationDate) {
                return res.status(402).json({
                    message: 'Obunangiz muddati tugagan!',
                    isExpired: true
                });
            }
        }

        if (!user.site_password_hash) {
            return res.status(400).json({ message: 'Foydalanuvchida parol o‘rnatilmagan!' });
        }

        // Parolni tekshirish: Ham Bcrypt hash, ham Oddiy tekst uchun xavfsiz solishtirish
        let isPasswordValid = false;
        try {
            if (user.site_password_hash.startsWith('$2b$') || user.site_password_hash.startsWith('$2a$')) {
                isPasswordValid = await bcrypt.compare(passwordInput, user.site_password_hash);
            } else {
                isPasswordValid = (passwordInput === user.site_password_hash);
            }
        } catch (bcryptErr) {
            console.error("Bcrypt solishtirish xatosi:", bcryptErr);
            isPasswordValid = (passwordInput === user.site_password_hash);
        }

        if (!isPasswordValid) {
            return res.status(400).json({ message: 'Login yoki parol noto‘g‘ri!' });
        }

        const token = jwt.sign(
            { userId: user.id, telegramId: user.telegram_id, login: user.site_login },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        return res.json({
            success: true,
            message: 'Muvaffaqiyatli tizimga kirdingiz!',
            token,
            user: {
                id: user.id,
                telegramId: user.telegram_id,
                login: user.site_login
            }
        });

    } catch (err) {
        console.error('Server xatosi (Login):', err);
        return res.status(500).json({
            message: 'Serverda xatolik yuz berdi',
            error: err.message
        });
    }
};

app.post('/api/login', handleLogin);
app.post('/api/auth/login', handleLogin);

// 3. ME API
app.get('/api/me', authenticateToken, async (req, res) => {
    try {
        const userResult = await pool.query(
            'SELECT id, telegram_id, full_name, username, site_login, is_paid, expires_at FROM public.users WHERE id = $1',
            [req.user.userId]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: 'Foydalanuvchi topilmadi!' });
        }

        return res.json(userResult.rows[0]);
    } catch (err) {
        console.error('Profil xatosi:', err);
        return res.status(500).json({ message: 'Serverda xatolik yuz berdi' });
    }
});

// 4. DASHBOARD API
const dashboardRouter = require('./routes/dashboardRoutes');
app.use('/api/dashboard', authenticateToken, dashboardRouter);

app.listen(PORT, () => {
    console.log(`Backend Server ${PORT}-portda ishga tushdi`);
});