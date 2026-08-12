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

// SSL sertifikat tekshiruvini sozlash (Render + Supabase uchun)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// PostgreSQL (Supabase) ulanishi
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_123';

// Yordamchi: Raqamlarni chiroyli formatlash funksiyasi
const formatSum = (val) => {
    if (val === undefined || val === null) return '0';
    return Number(val).toLocaleString('uz-UZ');
};

// ----------------------------------------------------
// 0. KERAKLI JADVALLARNI AVTOMATIK YARATISH
// ----------------------------------------------------
const ensureTables = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS public.products (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                category TEXT,
                name TEXT NOT NULL,
                cost_price NUMERIC NOT NULL DEFAULT 0,
                color TEXT,
                quantity INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMP NOT NULL DEFAULT NOW()
            );
        `);

        // Agar jadval avval bor bo'lsa va 'quantity' ustuni bo'lmasa, qo'shish
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 0;`);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS public.sales (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                product_id INTEGER NOT NULL,
                title TEXT,
                quantity INTEGER NOT NULL,
                cost_price NUMERIC NOT NULL DEFAULT 0,
                selling_price NUMERIC NOT NULL DEFAULT 0,
                profit NUMERIC NOT NULL DEFAULT 0,
                sold_at TIMESTAMP NOT NULL DEFAULT NOW()
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS public.expenses (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                amount NUMERIC NOT NULL DEFAULT 0,
                expense_type TEXT NOT NULL DEFAULT 'daily',
                created_at TIMESTAMP NOT NULL DEFAULT NOW()
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS public.notifications (
                id SERIAL PRIMARY KEY,
                site_login TEXT NOT NULL,
                message TEXT NOT NULL,
                is_sent BOOLEAN NOT NULL DEFAULT false,
                created_at TIMESTAMP NOT NULL DEFAULT NOW()
            );
        `);

        console.log('Barcha jadvallar tayyor (products, sales, expenses, notifications).');
    } catch (err) {
        console.error('Jadvallarni yaratishda xatolik:', err);
    }
};

ensureTables();

// ----------------------------------------------------
// 1. HEALTH CHECK ENDPOINTS
// ----------------------------------------------------
app.get('/', (req, res) => {
    res.send('Backend Server muvaffaqiyatli ishlayapti!');
});

app.get('/api/health', (req, res) => {
    res.send('Backend Server muvaffaqiyatli ishlayapti!');
});

// ----------------------------------------------------
// 2. LOGIN ENDPOINT
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
            return res.status(400).json({ message: "Login yoki parol noto'g'ri!" });
        }

        const user = userResult.rows[0];

        if (!user.is_paid) {
            return res.status(403).json({
                message: "To'lov qilganingizdan so'ng saytdan foydalana olasiz. Obunangiz faol emas!"
            });
        }

        if (user.expires_at && new Date(user.expires_at) < new Date()) {
            return res.status(403).json({
                message: "To'lov muddati tugagan! Iltimos, obunani yangilang, shundan so'ng saytdan foydalana olasiz."
            });
        }

        const cleanPassword = password.trim();
        let isPasswordValid = false;

        const dbPassword = user.site_password_hash || user.site_password || user.password;

        if (dbPassword) {
            if (dbPassword.startsWith('$2a$') || dbPassword.startsWith('$2b$')) {
                try {
                    isPasswordValid = await bcrypt.compare(cleanPassword, dbPassword);
                } catch (e) {
                    isPasswordValid = false;
                }
            } else {
                if (cleanPassword === dbPassword.trim()) {
                    isPasswordValid = true;
                }
            }
        }

        if (!isPasswordValid) {
            return res.status(400).json({ message: "Login yoki parol noto'g'ri!" });
        }

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
// 3. AUTH MIDDLEWARE
// ----------------------------------------------------
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ message: "Avtorizatsiyadan o'tilmagan!" });
    }

    try {
        const decoded = jwt.decode(token, JWT_SECRET);

        const userCheck = await pool.query(
            `SELECT is_paid, expires_at FROM public.users WHERE id = $1`,
            [decoded.userId]
        );

        if (userCheck.rows.length === 0) {
            return res.status(403).json({ message: "Foydalanuvchi topilmadi!" });
        }

        const currentUser = userCheck.rows[0];

        if (!currentUser.is_paid || (currentUser.expires_at && new Date(currentUser.expires_at) < new Date())) {
            return res.status(403).json({
                message: "To'lov muddati tugagan! To'lov qilganingizdan so'nggina saytdan foydalana olasiz."
            });
        }

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
// 5. STATISTIKA ENDPOINTI (GET /api/dashboard/stats)
// ----------------------------------------------------
app.get('/api/dashboard/stats', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;

        let storeName = '';
        try {
            const userRow = await pool.query(
                `SELECT full_name, site_login FROM public.users WHERE id = $1`,
                [userId]
            );
            if (userRow.rows.length > 0) {
                storeName = userRow.rows[0].full_name || userRow.rows[0].site_login || '';
            }
        } catch (e) {
            storeName = '';
        }

        const productStats = await pool.query(
            `SELECT 
                COUNT(id) as "totalProducts",
                COALESCE(SUM(quantity), 0) as "totalStock"
             FROM public.products
             WHERE user_id = $1`,
            [userId]
        );

        const getPeriodStats = async (salesDateFilter, expenseDateFilter) => {
            const salesResult = await pool.query(
                `SELECT 
                    COALESCE(SUM(quantity), 0) as "sold",
                    COALESCE(SUM(quantity * selling_price), 0) as "revenue",
                    COALESCE(SUM(profit), 0) as "grossProfit"
                 FROM public.sales
                 WHERE user_id = $1 AND ${salesDateFilter}`,
                [userId]
            );

            const expenseResult = await pool.query(
                `SELECT COALESCE(SUM(amount), 0) as "expense"
                 FROM public.expenses
                 WHERE user_id = $1 AND ${expenseDateFilter}`,
                [userId]
            );

            const sold = Number(salesResult.rows[0].sold || 0);
            const revenue = Number(salesResult.rows[0].revenue || 0);
            const grossProfit = Number(salesResult.rows[0].grossProfit || 0);
            const expense = Number(expenseResult.rows[0].expense || 0);

            return {
                sold,
                revenue,
                expense,
                profit: grossProfit - expense
            };
        };

        const daily = await getPeriodStats(
            `sold_at::date = CURRENT_DATE`,
            `created_at::date = CURRENT_DATE`
        );
        const monthly = await getPeriodStats(
            `date_trunc('month', sold_at) = date_trunc('month', CURRENT_DATE)`,
            `date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)`
        );
        const yearly = await getPeriodStats(
            `date_trunc('year', sold_at) = date_trunc('year', CURRENT_DATE)`,
            `date_trunc('year', created_at) = date_trunc('year', CURRENT_DATE)`
        );
        const total = await getPeriodStats(`TRUE`, `TRUE`);

        return res.json({
            storeName,
            totalProducts: Number(productStats.rows[0].totalProducts || 0),
            totalStock: Number(productStats.rows[0].totalStock || 0),

            totalSold: total.sold,
            totalRevenue: total.revenue,
            totalProfit: total.profit,
            totalExpense: total.expense,

            dailySold: daily.sold,
            dailyRevenue: daily.revenue,
            dailyProfit: daily.profit,
            dailyExpense: daily.expense,

            monthlySold: monthly.sold,
            monthlyRevenue: monthly.revenue,
            monthlyProfit: monthly.profit,
            monthlyExpense: monthly.expense,

            yearlySold: yearly.sold,
            yearlyRevenue: yearly.revenue,
            yearlyProfit: yearly.profit,
            yearlyExpense: yearly.expense
        });
    } catch (err) {
        console.error('Stats xatosi:', err);
        return res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
    }
});

// ----------------------------------------------------
// 6. TOVAR QO'SHISH (POST /api/products)
// ----------------------------------------------------
app.post('/api/products', authenticateToken, async (req, res) => {
    const { category, name, cost_price, color, quantity } = req.body;

    if (!name || cost_price === undefined) {
        return res.status(400).json({ message: "Tovar nomi va kelgan narxi kiritilishi shart!" });
    }

    const qtyValue = parseInt(quantity) || 0;

    try {
        const newProduct = await pool.query(
            `INSERT INTO public.products (user_id, category, name, cost_price, color, quantity)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [req.user.userId, category || null, name.trim(), Number(cost_price), color || null, qtyValue]
        );

        const product = newProduct.rows[0];

        const userRow = await pool.query(`SELECT site_login FROM public.users WHERE id = $1`, [req.user.userId]);
        if (userRow.rows.length > 0) {
            const siteLogin = userRow.rows[0].site_login;
            const message = `🆕 Yangi mahsulot qo'shildi:\n📦 Nomi: ${product.name}\n🎨 Rangi: ${product.color || 'Yo\'q'}\n🗂 Kategoriyasi: ${product.category || 'Yo\'q'}\n💰 Narxi: ${formatSum(product.cost_price)} so'm\n📊 Miqdori: ${product.quantity} dona`;

            await pool.query(
                `INSERT INTO public.notifications (site_login, message) VALUES ($1, $2)`,
                [siteLogin, message]
            );
        }

        return res.status(201).json({
            message: "Tovar muvaffaqiyatli qo'shildi",
            product: product
        });
    } catch (err) {
        console.error('Tovar qo\'shishda xatolik:', err);
        return res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
    }
});

// ----------------------------------------------------
// 7. TOVARLAR RO'YXATINI OLISH (GET /api/products)
// ----------------------------------------------------
app.get('/api/products', authenticateToken, async (req, res) => {
    try {
        const products = await pool.query(
            `SELECT id, user_id, category, name, name AS title, cost_price, color, quantity
             FROM public.products
             WHERE user_id = $1
             ORDER BY id DESC`,
            [req.user.userId]
        );

        return res.json({ products: products.rows });
    } catch (err) {
        console.error('Tovarlarni olishda xatolik:', err);
        return res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
    }
});

// ----------------------------------------------------
// 8. TOVARNI SOTISH (POST /api/dashboard/sell)
// ----------------------------------------------------
app.post('/api/dashboard/sell', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const { product_id, sell_quantity, selling_price } = req.body;

    const qty = parseInt(sell_quantity);
    const price = parseFloat(selling_price);

    if (!product_id) {
        return res.status(400).json({ message: "Tovar tanlanishi shart!" });
    }
    if (!qty || qty <= 0) {
        return res.status(400).json({ message: "Sotuv soni to'g'ri kiritilishi shart!" });
    }
    if (isNaN(price) || price < 0) {
        return res.status(400).json({ message: "Sotish narxi to'g'ri kiritilishi shart!" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const productResult = await client.query(
            `SELECT * FROM public.products WHERE id = $1 AND user_id = $2 FOR UPDATE`,
            [product_id, userId]
        );

        if (productResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Tovar topilmadi!" });
        }

        const product = productResult.rows[0];

        if (Number(product.quantity) < qty) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "Omborda yetarli tovar yo'q!" });
        }

        const costPrice = Number(product.cost_price) || 0;
        const profit = (price - costPrice) * qty;
        const newQuantity = Number(product.quantity) - qty;

        await client.query(
            `INSERT INTO public.sales (user_id, product_id, title, quantity, cost_price, selling_price, profit)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [userId, product.id, product.name, qty, costPrice, price, profit]
        );

        let productFullySoldOut = false;
        if (newQuantity === 0) {
            await client.query(`DELETE FROM public.products WHERE id = $1`, [product_id]);
            productFullySoldOut = true;
        } else {
            await client.query(`UPDATE public.products SET quantity = $1 WHERE id = $2`, [newQuantity, product_id]);
        }

        const userRow = await client.query(`SELECT site_login FROM public.users WHERE id = $1`, [userId]);
        const siteLogin = userRow.rows.length > 0 ? userRow.rows[0].site_login : 'unknown';

        let sellMessage = `💰 Tovar sotildi:\n📦 Nomi: ${product.name}\n🗂 Kategoriyasi: ${product.category || 'Yo\'q'}\n🎨 Rangi: ${product.color || 'Yo\'q'}\n📊 Sotilgan soni: ${qty} dona\n💵 Sotish narxi: ${formatSum(price)} so'm\n📈 Foyda: ${formatSum(profit)} so'm\n\n📋 Qolgan soni: ${newQuantity} dona`;

        if (productFullySoldOut) {
            sellMessage = `🗑 Tovar sotilib butunlay tugadi va o'chirildi:\n📦 Nomi: ${product.name}\n🗂 Kategoriyasi: ${product.category || 'Yo\'q'}\n🎨 Rangi: ${product.color || 'Yo\'q'}\n📊 Sotilgan soni: ${qty} dona\n💵 Sotish narxi: ${formatSum(price)} so'm\n📈 Foyda: ${formatSum(profit)} so'm`;
        }

        await client.query(
            `INSERT INTO public.notifications (site_login, message) VALUES ($1, $2)`,
            [siteLogin, sellMessage]
        );

        await client.query('COMMIT');

        return res.json({
            message: "Tovar muvaffaqiyatli sotildi",
            newQuantity: productFullySoldOut ? 0 : newQuantity,
            productFullySoldOut,
            profit
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Sotishda xatolik:', err);
        return res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
    } finally {
        client.release();
    }
});

// ----------------------------------------------------
// 9. TOVARNI OLIB TASHLASH / O'CHIRISH (POST /api/dashboard/delete-product)
// ----------------------------------------------------
app.post('/api/dashboard/delete-product', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const { product_id, remove_all, quantity_to_remove } = req.body;

    if (!product_id) {
        return res.status(400).json({ message: "Tovar tanlanishi shart!" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const productResult = await client.query(
            `SELECT * FROM public.products WHERE id = $1 AND user_id = $2 FOR UPDATE`,
            [product_id, userId]
        );

        if (productResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Tovar topilmadi!" });
        }

        const product = productResult.rows[0];
        const removeQty = remove_all ? Number(product.quantity) : (parseInt(quantity_to_remove) || 1);

        if (removeQty <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "Olib tashlanadigan son to'g'ri kiritilishi shart!" });
        }

        let productFullySoldOut = false;
        let newQty = Number(product.quantity) - removeQty;

        if (removeQty >= Number(product.quantity) || newQty <= 0) {
            await client.query(`DELETE FROM public.products WHERE id = $1`, [product_id]);
            productFullySoldOut = true;
            newQty = 0;
        } else {
            await client.query(`UPDATE public.products SET quantity = $1 WHERE id = $2`, [newQty, product_id]);
        }

        const userRow = await client.query(`SELECT site_login FROM public.users WHERE id = $1`, [userId]);
        const siteLogin = userRow.rows.length > 0 ? userRow.rows[0].site_login : 'unknown';

        const message = `📉 Mahsulot kamaytirildi/o'chirildi:\n📦 Nomi: ${product.name}\n🎨 Rangi: ${product.color || 'Yo\'q'}\n📊 Olib tashlandi: ${removeQty} dona\n📋 Qolgan soni: ${newQty} dona`;

        await client.query(
            `INSERT INTO public.notifications (site_login, message) VALUES ($1, $2)`,
            [siteLogin, message]
        );

        await client.query('COMMIT');

        return res.json({
            message: "Amal bajarildi",
            productFullySoldOut,
            remainingQuantity: newQty
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('O\'chirishda xatolik:', err);
        return res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
    } finally {
        client.release();
    }
});

// ----------------------------------------------------
// 10. RASXOD QO'SHISH (POST /api/dashboard/expenses)
// ----------------------------------------------------
app.post('/api/dashboard/expenses', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const { title, amount, expense_type } = req.body;

    const parsedAmount = parseFloat(amount);

    if (!title || !title.trim()) {
        return res.status(400).json({ message: "Rasxod nomi kiritilishi shart!" });
    }
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({ message: "Rasxod summasi to'g'ri kiritilishi shart!" });
    }

    const type = ['daily', 'monthly', 'yearly'].includes(expense_type) ? expense_type : 'daily';

    try {
        const newExpense = await pool.query(
            `INSERT INTO public.expenses (user_id, title, amount, expense_type)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [userId, title.trim(), parsedAmount, type]
        );

        const expense = newExpense.rows[0];

        const userRow = await pool.query(`SELECT site_login FROM public.users WHERE id = $1`, [userId]);
        if (userRow.rows.length > 0) {
            const siteLogin = userRow.rows[0].site_login;
            const message = `💸 Yangi rasxod qo'shildi:\n📝 Tavsifi: ${expense.title}\n💰 Summasi: ${formatSum(expense.amount)} so'm\n📅 Sanasi: ${new Date(expense.created_at).toISOString().split('T')[0]}`;

            await pool.query(
                `INSERT INTO public.notifications (site_login, message) VALUES ($1, $2)`,
                [siteLogin, message]
            );
        }

        return res.status(201).json({
            message: "Rasxod muvaffaqiyatli qo'shildi",
            expense: expense
        });
    } catch (err) {
        console.error('Rasxod qo\'shishda xatolik:', err);
        return res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
    }
});

// ----------------------------------------------------
// 11. BOT UCHUN DAVRLI FOYDALARNI OLISH ENDPOINTI
// ----------------------------------------------------
app.get('/api/bot/profits/:site_login', async (req, res) => {
    const { site_login } = req.params;

    try {
        const userResult = await pool.query(
            `SELECT id FROM public.users WHERE site_login = $1`,
            [site_login]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: "Foydalanuvchi topilmadi!" });
        }

        const userId = userResult.rows[0].id;

        const getPeriodProfit = async (salesDateFilter, expenseDateFilter) => {
            const salesResult = await pool.query(
                `SELECT COALESCE(SUM(profit), 0) as "grossProfit"
                 FROM public.sales
                 WHERE user_id = $1 AND ${salesDateFilter}`,
                [userId]
            );

            const expenseResult = await pool.query(
                `SELECT COALESCE(SUM(amount), 0) as "expense"
                 FROM public.expenses
                 WHERE user_id = $1 AND ${expenseDateFilter}`,
                [userId]
            );

            const grossProfit = Number(salesResult.rows[0].grossProfit || 0);
            const expense = Number(expenseResult.rows[0].expense || 0);

            return grossProfit - expense;
        };

        const dailyProfit = await getPeriodProfit(
            `sold_at::date = CURRENT_DATE`,
            `created_at::date = CURRENT_DATE`
        );
        const weeklyProfit = await getPeriodProfit(
            `sold_at >= date_trunc('week', CURRENT_DATE)`,
            `created_at >= date_trunc('week', CURRENT_DATE)`
        );
        const monthlyProfit = await getPeriodProfit(
            `date_trunc('month', sold_at) = date_trunc('month', CURRENT_DATE)`,
            `date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)`
        );
        const yearlyProfit = await getPeriodProfit(
            `date_trunc('year', sold_at) = date_trunc('year', CURRENT_DATE)`,
            `date_trunc('year', created_at) = date_trunc('year', CURRENT_DATE)`
        );

        return res.json({
            success: true,
            site_login,
            dailyProfit,
            weeklyProfit,
            monthlyProfit,
            yearlyProfit
        });

    } catch (err) {
        console.error('Bot profits xatosi:', err);
        return res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
    }
});

// ----------------------------------------------------
// 12. SAFE ROUTE FALLBACK
// ----------------------------------------------------
app.use((req, res) => {
    res.status(404).json({ message: "Bunday yo'nalish topilmadi" });
});

// SERVERNI ISHGA TUSHIRISH
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Backend Server ${PORT}-portda ishga tushdi 🚀`);
});