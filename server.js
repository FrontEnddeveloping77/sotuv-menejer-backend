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

// ----------------------------------------------------
// 0. KERAKLI JADVALLARNI AVTOMATIK YARATISH
// ----------------------------------------------------
// MUHIM: Endi har bir mahsulot bir nechta o'lcham-son juftligiga ega bo'lishi mumkin.
// products jadvali endi umumiy ma'lumotni (nomi, rangi, kategoriyasi, narxi) saqlaydi,
// har bir o'lchamning aloxida soni esa product_sizes jadvalida saqlanadi.
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
                created_at TIMESTAMP NOT NULL DEFAULT NOW()
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS public.product_sizes (
                id SERIAL PRIMARY KEY,
                product_id INTEGER NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
                size TEXT NOT NULL,
                quantity INTEGER NOT NULL DEFAULT 0
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS public.sales (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                product_id INTEGER NOT NULL,
                title TEXT,
                size TEXT,
                quantity INTEGER NOT NULL,
                cost_price NUMERIC NOT NULL DEFAULT 0,
                selling_price NUMERIC NOT NULL DEFAULT 0,
                profit NUMERIC NOT NULL DEFAULT 0,
                sold_at TIMESTAMP NOT NULL DEFAULT NOW()
            );
        `);
        // Eski sales jadvalida 'size' ustuni bo'lmasligi mumkin - qo'shib qo'yamiz
        await pool.query(`ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS size TEXT;`);

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

        console.log('Barcha jadvallar tayyor (products, product_sizes, sales, expenses, notifications).');
    } catch (err) {
        console.error('Jadvallarni yaratishda xatolik:', err);
    }
};

ensureTables();

// ----------------------------------------------------
// Yordamchi: mahsulotning qolgan o'lchamlarini matn ko'rinishida qaytaradi
// ----------------------------------------------------
async function getRemainingSizesText(productId) {
    const result = await pool.query(
        `SELECT size, quantity FROM public.product_sizes WHERE product_id = $1 ORDER BY size`,
        [productId]
    );
    if (result.rows.length === 0) {
        return "Qolmadi (barcha o'lchamlar tugadi)";
    }
    return result.rows.map(r => `${r.size}: ${r.quantity} dona`).join(', ');
}

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
// 2. LOGIN ENDPOINT (Obuna va muddat tekshiruvi bilan)
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

        // Endi umumiy zaxira product_sizes jadvali orqali hisoblanadi
        const productStats = await pool.query(
            `SELECT 
                COUNT(DISTINCT p.id) as "totalProducts",
                COALESCE(SUM(ps.quantity), 0) as "totalStock"
             FROM public.products p
             LEFT JOIN public.product_sizes ps ON ps.product_id = p.id
             WHERE p.user_id = $1`,
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
// Endi 'sizes' massivi qabul qilinadi: [{ size: "40", quantity: 5 }, { size: "41", quantity: 3 }, ...]
// ----------------------------------------------------
app.post('/api/products', authenticateToken, async (req, res) => {
    const { category, name, cost_price, color, size, quantity } = req.body;

    if (!name || cost_price === undefined) {
        return res.status(400).json({ message: "Tovar nomi va kelgan narxi kiritilishi shart!" });
    }

    const sizeValue = size ? String(size).trim() : 'Standart';
    const qtyValue = parseInt(quantity) || 0; // Miqdorni aniq o'qib olamiz

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const newProduct = await client.query(
            `INSERT INTO public.products (user_id, category, name, cost_price, color)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [req.user.userId, category || null, name.trim(), Number(cost_price), color || null]
        );

        const product = newProduct.rows[0];

        // Miqdorni product_sizes jadvaliga to'g'ri yozamiz
        await client.query(
            `INSERT INTO public.product_sizes (product_id, size, quantity) VALUES ($1, $2, $3)`,
            [product.id, sizeValue, qtyValue]
        );

        await client.query('COMMIT');

        const userRow = await pool.query(`SELECT site_login FROM public.users WHERE id = $1`, [req.user.userId]);
        if (userRow.rows.length > 0) {
            const siteLogin = userRow.rows[0].site_login;
            const message = `🆕 Yangi mahsulot qo'shildi:\n📦 Nomi: ${product.name}\n🎨 Rangi: ${product.color || 'Yo\'q'}\n📏 O'lchami: ${sizeValue}\n🗂 Kategoriyasi: ${product.category || 'Yo\'q'}\n💰 Narxi: ${product.cost_price} so'm\n📊 Miqdori: ${qtyValue} dona`;

            await pool.query(
                `INSERT INTO public.notifications (site_login, message) VALUES ($1, $2)`,
                [siteLogin, message]
            );
        }

        return res.status(201).json({ message: "Tovar muvaffaqiyatli qo'shildi" });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Xatolik:', err);
        return res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
    } finally {
        client.release();
    }
});

const sizeValue = size ? String(size).trim() : 'Standart';
const qtyValue = parseInt(quantity) || 0;

const client = await pool.connect();
try {
    await client.query('BEGIN');

    const newProduct = await client.query(
        `INSERT INTO public.products (user_id, category, name, cost_price, color)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
        [req.user.userId, category || null, name.trim(), Number(cost_price), color || null]
    );

    const product = newProduct.rows[0];

    await client.query(
        `INSERT INTO public.product_sizes (product_id, size, quantity) VALUES ($1, $2, $3)`,
        [product.id, sizeValue, qtyValue]
    );

    await client.query('COMMIT');

    // Foydalanuvchining site_login ni topib, telegramga ketadigan xabarnomani yozish
    const userRow = await pool.query(`SELECT site_login FROM public.users WHERE id = $1`, [req.user.userId]);
    if (userRow.rows.length > 0) {
        const siteLogin = userRow.rows[0].site_login;

        // Siz xohlagan aniq shablon bo'yicha xabar matni
        const message = `🆕 Yangi mahsulot qo'shildi:\n📦 Nomi: ${product.name}\n🎨 Rangi: ${product.color || 'Yo\'q'}\n📏 O'lchami: ${sizeValue}\n🗂 Kategoriyasi: ${product.category || 'Yo\'q'}\n💰 Narxi: ${formatSum(product.cost_price)} so'm\n📊 Miqdori: ${qtyValue} dona`;

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
    await client.query('ROLLBACK');
    console.error('Tovar qo\'shishda xatolik:', err);
    return res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
} finally {
    client.release();
}

// ----------------------------------------------------
// 7. TOVARLAR RO'YXATINI OLISH (GET /api/products)
// Har bir mahsulot o'zining barcha o'lcham-son juftliklari bilan qaytadi
// ----------------------------------------------------
app.get('/api/products', authenticateToken, async (req, res) => {
    try {
        const products = await pool.query(
            `SELECT 
                p.id, p.user_id, p.category, p.name, p.name AS title, p.cost_price, p.color,
                COALESCE(
                    json_agg(
                        json_build_object('size', ps.size, 'quantity', ps.quantity)
                    ) FILTER (WHERE ps.id IS NOT NULL),
                    '[]'
                ) AS sizes,
                COALESCE(SUM(ps.quantity), 0) AS total_quantity
             FROM public.products p
             LEFT JOIN public.product_sizes ps ON ps.product_id = p.id
             WHERE p.user_id = $1
             GROUP BY p.id
             ORDER BY p.id DESC`,
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
// Endi 'size' MAJBURIY: aynan qaysi o'lcham sotilganini bildiradi
// ----------------------------------------------------
app.post('/api/dashboard/sell', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const { product_id, size, sell_quantity, selling_price } = req.body;

    const qty = parseInt(sell_quantity);
    const price = parseFloat(selling_price);

    if (!product_id || !size) {
        return res.status(400).json({ message: "Tovar va o'lchami tanlanishi shart!" });
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
            `SELECT * FROM public.products WHERE id = $1 AND user_id = $2`,
            [product_id, userId]
        );

        if (productResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Tovar topilmadi!" });
        }

        const product = productResult.rows[0];

        const sizeResult = await client.query(
            `SELECT * FROM public.product_sizes WHERE product_id = $1 AND size = $2 FOR UPDATE`,
            [product_id, size]
        );

        if (sizeResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Bu tovarda tanlangan o'lcham topilmadi!" });
        }

        const sizeRow = sizeResult.rows[0];

        if (Number(sizeRow.quantity) < qty) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "Omborda bu o'lchamdan yetarli tovar yo'q!" });
        }

        const costPrice = Number(product.cost_price) || 0;
        const profit = (price - costPrice) * qty;
        const newSizeQuantity = Number(sizeRow.quantity) - qty;

        // Savdoni qayd etish (aynan qaysi o'lcham sotilgani bilan)
        await client.query(
            `INSERT INTO public.sales (user_id, product_id, title, size, quantity, cost_price, selling_price, profit)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [userId, product.id, product.name, size, qty, costPrice, price, profit]
        );

        let sizeSoldOut = false;
        if (newSizeQuantity === 0) {
            await client.query(`DELETE FROM public.product_sizes WHERE id = $1`, [sizeRow.id]);
            sizeSoldOut = true;
        } else {
            await client.query(`UPDATE public.product_sizes SET quantity = $1 WHERE id = $2`, [newSizeQuantity, sizeRow.id]);
        }

        // Shu mahsulotda boshqa o'lchamlar qolganmi, tekshiramiz
        const remainingSizesResult = await client.query(
            `SELECT size, quantity FROM public.product_sizes WHERE product_id = $1 ORDER BY size`,
            [product_id]
        );

        let productFullySoldOut = false;
        if (remainingSizesResult.rows.length === 0) {
            // Barcha o'lchamlar tugagan - mahsulotning o'zini ham o'chiramiz
            await client.query(`DELETE FROM public.products WHERE id = $1`, [product_id]);
            productFullySoldOut = true;
        }

        const userRow = await client.query(`SELECT site_login FROM public.users WHERE id = $1`, [userId]);
        const siteLogin = userRow.rows.length > 0 ? userRow.rows[0].site_login : 'unknown';

        const remainingSizesText = remainingSizesResult.rows.length > 0
            ? remainingSizesResult.rows.map(r => `${r.size}: ${r.quantity} dona`).join(', ')
            : "Qolmadi (barcha o'lchamlar tugadi)";

        let sellMessage = `💰 Tovar sotildi:\n📦 Nomi: ${product.name}\n🗂 Kategoriyasi: ${product.category || 'Yo\'q'}\n🎨 Rangi: ${product.color || 'Yo\'q'}\n📏 Sotilgan o'lcham: ${size}\n📊 Sotilgan soni: ${qty} dona\n💵 Sotish narxi: ${price} so'm\n📈 Foyda: ${profit} so'm\n\n📋 Qolgan o'lchamlar: ${remainingSizesText}`;

        if (productFullySoldOut) {
            sellMessage = `🗑 Tovar sotilib butunlay tugadi va o'chirildi:\n📦 Nomi: ${product.name}\n🗂 Kategoriyasi: ${product.category || 'Yo\'q'}\n🎨 Rangi: ${product.color || 'Yo\'q'}\n📏 Sotilgan o'lcham: ${size}\n📊 Sotilgan soni: ${qty} dona\n💵 Sotish narxi: ${price} so'm\n📈 Foyda: ${profit} so'm`;
        }

        await client.query(
            `INSERT INTO public.notifications (site_login, message) VALUES ($1, $2)`,
            [siteLogin, sellMessage]
        );

        await client.query('COMMIT');

        return res.json({
            message: "Tovar muvaffaqiyatli sotildi",
            size,
            newSizeQuantity: sizeSoldOut ? 0 : newSizeQuantity,
            remainingSizes: remainingSizesResult.rows,
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
// Endi 'size' MAJBURIY: aynan qaysi o'lchamdan olib tashlanishi kerakligini bildiradi
// ----------------------------------------------------
app.post('/api/dashboard/delete-product', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const { product_id, size, remove_all, quantity_to_remove } = req.body;

    if (!product_id || !size) {
        return res.status(400).json({ message: "Tovar va o'lchami tanlanishi shart!" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const productResult = await client.query(
            `SELECT * FROM public.products WHERE id = $1 AND user_id = $2`,
            [product_id, userId]
        );

        if (productResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Tovar topilmadi!" });
        }

        const product = productResult.rows[0];

        const sizeResult = await client.query(
            `SELECT * FROM public.product_sizes WHERE product_id = $1 AND size = $2 FOR UPDATE`,
            [product_id, size]
        );

        if (sizeResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Bu tovarda tanlangan o'lcham topilmadi!" });
        }

        const sizeRow = sizeResult.rows[0];
        const removeQty = remove_all ? Number(sizeRow.quantity) : (parseInt(quantity_to_remove) || 1);

        if (removeQty <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "Olib tashlanadigan son to'g'ri kiritilishi shart!" });
        }

        if (removeQty >= Number(sizeRow.quantity)) {
            await client.query(`DELETE FROM public.product_sizes WHERE id = $1`, [sizeRow.id]);
        } else {
            await client.query(
                `UPDATE public.product_sizes SET quantity = $1 WHERE id = $2`,
                [Number(sizeRow.quantity) - removeQty, sizeRow.id]
            );
        }

        const remainingSizesResult = await client.query(
            `SELECT size, quantity FROM public.product_sizes WHERE product_id = $1 ORDER BY size`,
            [product_id]
        );

        let productFullySoldOut = false;
        if (remainingSizesResult.rows.length === 0) {
            await client.query(`DELETE FROM public.products WHERE id = $1`, [product_id]);
            productFullySoldOut = true;
        }

        const userRow = await client.query(`SELECT site_login FROM public.users WHERE id = $1`, [userId]);
        const siteLogin = userRow.rows.length > 0 ? userRow.rows[0].site_login : 'unknown';

        const remainingSizesText = remainingSizesResult.rows.length > 0
            ? remainingSizesResult.rows.map(r => `${r.size}: ${r.quantity} dona`).join(', ')
            : "Qolmadi (barcha o'lchamlar tugadi)";

        const message = `📉 Mahsulotdan o'lcham olib tashlandi:\n📦 Nomi: ${product.name}\n🎨 Rangi: ${product.color || 'Yo\'q'}\n📏 O'lcham: ${size} (${removeQty} dona olib tashlandi)\n\n📋 Qolgan o'lchamlar: ${remainingSizesText}`;

        await client.query(
            `INSERT INTO public.notifications (site_login, message) VALUES ($1, $2)`,
            [siteLogin, message]
        );

        await client.query('COMMIT');

        return res.json({
            message: "Amal bajarildi",
            productFullySoldOut,
            remainingSizes: remainingSizesResult.rows
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
            const message = `💸 Yangi rasxod qo'shildi:\n📝 Tavsifi: ${expense.title}\n💰 Summasi: ${expense.amount} so'm\n📅 Sanasi: ${new Date(expense.created_at).toISOString().split('T')[0]}`;

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
    console.log(`Backend Server ${PORT}-portda ishga tushdi`);
});