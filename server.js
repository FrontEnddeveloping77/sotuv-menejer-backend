const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_maxfiy_kalit_123!';

// Express Middleware
app.use(cors());
app.use(express.json());

// 1. PostgreSQL Baza Sozlamalari
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'mybot_db',          // pgAdmin'dagi baza nomingiz
    password: 'a2012a',            // PostgreSQL parolingiz
    port: 5432,
});

// App-ga pool ob'ektini ulash
app.set('pool', pool);

// Bazaga ulanishni tekshirish
pool.connect((err, client, release) => {
    if (err) {
        return console.error('PostgreSQL bazasiga ulanishda xatolik:', err.stack);
    }
    console.log('PostgreSQL bazasiga muvaffaqiyatli ulandi!');
    release();
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

// ------------------- API MARSHRUTLARI ------------------- //

// 2. LOGIN API (Frontend so'rovi uchun moslashtirildi)
// Ikkala yo'ldan ham kirish imkoniyati qo'shildi: /api/login va /api/auth/login
const handleLogin = async (req, res) => {
    // Frontend 'username' yoki 'login' kaliti bilan yuborishi mumkin
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

        // 1-Tekshiruv: Foydalanuvchi mavjudligi
        if (userResult.rows.length === 0) {
            return res.status(400).json({ message: 'Login yoki parol noto‘g‘ri!' });
        }

        const user = userResult.rows[0];

        // 2-Tekshiruv: Obuna faolligi (is_paid)
        if (!user.is_paid) {
            return res.status(403).json({ message: 'Obunangiz faol emas!' });
        }

        // 3-Tekshiruv: Obuna muddati (expires_at)
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

        // 4-Tekshiruv: Parol va bcryptjs solishtiruvi
        if (!user.site_password_hash) {
            return res.status(400).json({ message: 'Foydalanuvchida parol o‘rnatilmagan!' });
        }

        const isPasswordValid = await bcrypt.compare(passwordInput, user.site_password_hash);

        if (!isPasswordValid) {
            return res.status(400).json({ message: 'Login yoki parol noto‘g‘ri!' });
        }

        // Muvaffaqiyatli avtorizatsiya — JWT Token taqdim etamiz
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
        console.error('Server xatosi:', err);
        return res.status(500).json({ message: 'Serverda xatolik yuz berdi' });
    }
};

app.post('/api/login', handleLogin);
app.post('/api/auth/login', handleLogin);

// 3. ME API (Profil ma'lumotlarini olish)
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

// 4. DASHBOARD API (Do'kon, tovarlar va sotuvlar analitikasi)
// Faylingiz papkasiga qarab dashboard.js yoki dashboardRoutes.js tanlanadi:
const dashboardRouter = require('./routes/dashboardRoutes'); // Yoki './routes/dashboard'
app.use('/api/dashboard', authenticateToken, dashboardRouter);

// Serverni ishga tushirish
app.listen(PORT, () => {
    console.log(`Backend Server ${PORT}-portda ishga tushdi`);
});