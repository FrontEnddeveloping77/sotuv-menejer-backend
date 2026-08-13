// backend/server.js

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jwt-simple');
const { randomUUID } = require('crypto');

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
                local_id INTEGER NOT NULL DEFAULT 1,
                category TEXT,
                name TEXT NOT NULL,
                cost_price NUMERIC NOT NULL DEFAULT 0,
                color TEXT,
                quantity INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMP NOT NULL DEFAULT NOW()
            );
        `);

        // Agar jadval avval bor bo'lsa va 'quantity' yoki 'local_id' ustunlari bo'lmasa, qo'shish
        // Telegram guruh integratsiyasi: chat_id sayt tomonidan kiritilmaydi.
        // Telegram bot login+parol tasdiqlanganda bu ustunni avtomatik to'ldiradi.
        await pool.query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS linked_group_chat_id BIGINT;`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_linked_group_chat_id ON public.users(linked_group_chat_id);`);

        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 0;`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS local_id INTEGER NOT NULL DEFAULT 1;`);
        // RAZMER (SIZE) ustuni: bir xil tovarning turli o'lchamlari alohida qator sifatida saqlanadi,
        // lekin bir xil local_id orqali "bitta tovar" sifatida guruhlanadi.
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS size TEXT;`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS qr_token UUID;`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS qr_created_at TIMESTAMP;`);
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_products_qr_token ON public.products(qr_token) WHERE qr_token IS NOT NULL;`);

        // Mavjud tovarlarga ham QR token beramiz.
        const qrRows = await pool.query(`SELECT id FROM public.products WHERE qr_token IS NULL`);
        for (const row of qrRows.rows) {
            await pool.query(
                `UPDATE public.products SET qr_token = $1, qr_created_at = NOW() WHERE id = $2 AND qr_token IS NULL`,
                [randomUUID(), row.id]
            );
        }

        await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_user_local ON public.products(user_id, local_id);`);

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
                COUNT(DISTINCT local_id) as "totalProducts",
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
// 6. TOVAR QO'SHISH (POST /api/products) - LOCAL_ID VA RAZMERLAR BILAN
// ----------------------------------------------------
// Foydalanuvchi bir nechta razmer kiritishi mumkin (masalan "39, 40, 41, 42, 43")
// va umumiy sonni kiritadi (masalan 10 ta). Bu funksiya umumiy sonni har bir
// razmerga avtomatik ravishda (imkon qadar teng) taqsimlaydi va har bir razmer
// uchun alohida qator (row) yaratadi, lekin barchasi bitta local_id ostida
// "bitta tovar" sifatida guruhlanadi.
app.post('/api/products', authenticateToken, async (req, res) => {
    const { category, name, cost_price, color, quantity, sizes } = req.body;

    if (!name || cost_price === undefined) {
        return res.status(400).json({ message: "Tovar nomi va kelgan narxi kiritilishi shart!" });
    }

    const totalQty = parseInt(quantity) || 0;
    if (totalQty <= 0) {
        return res.status(400).json({ message: "Soni to'g'ri (0 dan katta) kiritilishi shart!" });
    }

    const userId = req.user.userId;

    // Razmerlar satrini tozalab, takrorlanmas ro'yxatga aylantiramiz
    let sizeList = [];
    if (sizes && typeof sizes === 'string' && sizes.trim() !== '') {
        const seen = new Set();
        sizes.split(',').forEach((s) => {
            const clean = s.trim();
            if (clean.length > 0 && !seen.has(clean.toLowerCase())) {
                seen.add(clean.toLowerCase());
                sizeList.push(clean);
            }
        });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Shu do'kon uchun oxirgi local_id ni topib, +1 qo'shamiz (1 dan boshlanadi)
        const lastProduct = await client.query(
            `SELECT local_id FROM public.products WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
            [userId]
        );

        const nextLocalId = lastProduct.rows.length > 0 ? Number(lastProduct.rows[0].local_id) + 1 : 1;

        const insertedRows = [];

        if (sizeList.length === 0) {
            // Razmersiz tovar - bitta qator, butun son shu qatorga yoziladi
            const inserted = await client.query(
                `INSERT INTO public.products (user_id, local_id, category, name, cost_price, color, size, quantity, qr_token, qr_created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
                 RETURNING *`,
                [userId, nextLocalId, category || null, name.trim(), Number(cost_price), color || null, null, totalQty, randomUUID()]
            );
            insertedRows.push(inserted.rows[0]);
        } else {
            // RAZMERLARGA AVTOMATIK TAQSIMLASH LOGIKASI
            // Masalan: 5 ta razmer, 10 ta son -> har biriga 2 tadan
            // Qoldiq bo'lsa (masalan 11 ta / 5 razmer = 2 qoldiq 1), qoldiq birinchi
            // razmerlardan boshlab birma-bir qo'shiladi (2,2,2,2,3 emas -> 3,2,2,2,2)
            const n = sizeList.length;
            const base = Math.floor(totalQty / n);
            const remainder = totalQty % n;

            for (let i = 0; i < n; i++) {
                const sizeQty = base + (i < remainder ? 1 : 0);
                const inserted = await client.query(
                    `INSERT INTO public.products (user_id, local_id, category, name, cost_price, color, size, quantity, qr_token, qr_created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
                     RETURNING *`,
                    [userId, nextLocalId, category || null, name.trim(), Number(cost_price), color || null, sizeList[i], sizeQty, randomUUID()]
                );
                insertedRows.push(inserted.rows[0]);
            }
        }

        const userRow = await client.query(`SELECT site_login FROM public.users WHERE id = $1`, [userId]);
        if (userRow.rows.length > 0) {
            const siteLogin = userRow.rows[0].site_login;
            const first = insertedRows[0];

            let sizesBlock = '';
            if (sizeList.length > 0) {
                const lines = insertedRows.map((r) => `   • ${r.size}: ${r.quantity} dona`).join('\n');
                sizesBlock = `\n📏 <b>Razmerlar bo'yicha taqsimot:</b>\n${lines}`;
            }

            const message = `🆕 <b>YANGI MAHSULOT QO'SHILDI (#${nextLocalId})</b>\n━━━━━━━━━━━━━━━━━━━━\n📦 <b>Nomi:</b> ${first.name}\n🎨 <b>Rangi:</b> ${first.color || "Yo'q"}\n🗂 <b>Kategoriyasi:</b> ${first.category || "Yo'q"}\n💰 <b>Narxi:</b> ${formatSum(first.cost_price)} so'm\n📊 <b>Umumiy miqdori:</b> ${totalQty} dona${sizesBlock}\n━━━━━━━━━━━━━━━━━━━━\n✅ Ombor yangilandi!`;

            await client.query(
                `INSERT INTO public.notifications (site_login, message) VALUES ($1, $2)`,
                [siteLogin, message]
            );
        }

        await client.query('COMMIT');

        return res.status(201).json({
            message: sizeList.length > 0
                ? `Tovar saqlandi! ${sizeList.length} ta razmer bo'yicha taqsimlandi (ID: #${nextLocalId})`
                : `Tovar saqlandi! ID: #${nextLocalId}`,
            product: insertedRows[0],
            products: insertedRows,
            local_id: nextLocalId
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Tovar qo\'shishda xatolik:', err);
        return res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
    } finally {
        client.release();
    }
});

// ----------------------------------------------------
// 7. TOVARLAR RO'YXATINI OLISH (GET /api/products)
// ----------------------------------------------------
app.get('/api/products', authenticateToken, async (req, res) => {
    try {
        // Eng yangi qo'shilgan tovar (local_id) tepada turadi, har bir tovar ichida
        // esa razmerlar o'sish tartibida (raqamli bo'lsa raqam bo'yicha, aks holda
        // alifbo bo'yicha) tartiblanadi - shu bilan interfeysda chiroyli guruhlanadi.
        const products = await pool.query(
            `SELECT id, user_id, local_id, category, name, name AS title, cost_price, color, size, quantity, qr_token
             FROM public.products
             WHERE user_id = $1
             ORDER BY local_id DESC,
                      CASE WHEN size ~ '^[0-9]+$' THEN size::int END ASC NULLS LAST,
                      size ASC NULLS LAST,
                      id ASC`,
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
// Bu marshrut ikki xil formatni qabul qiladi:
//   1) Eski (yagona razmer) format: { product_id, sell_quantity, selling_price }
//   2) Yangi (bir nechta razmer / "savatcha") format: { items: [{ product_id, sell_quantity, selling_price }, ...] }
// Har ikkala holatda ham barcha razmerlar BITTA tranzaksiya ichida, har biri
// alohida ombor qatoridan (product_id = aniq bazadagi id) to'g'ri ayiriladi.
app.post('/api/dashboard/sell', authenticateToken, async (req, res) => {
    const userId = req.user.userId;

    let items = Array.isArray(req.body.items) ? req.body.items : null;
    if (!items) {
        const { product_id, sell_quantity, selling_price } = req.body;
        items = [{ product_id, sell_quantity, selling_price }];
    }

    if (items.length === 0) {
        return res.status(400).json({ message: "Kamida bitta tovar/razmer tanlanishi shart!" });
    }

    // Har bir itemni oldindan tekshirib olamiz (haqiqiy bazaga murojaat qilishdan oldin)
    const normalizedItems = [];
    for (const raw of items) {
        const product_id = raw.product_id;
        const qty = parseInt(raw.sell_quantity);
        const price = parseFloat(raw.selling_price);

        if (!product_id) {
            return res.status(400).json({ message: "Tovar tanlanishi shart!" });
        }
        if (!qty || qty <= 0) {
            return res.status(400).json({ message: "Sotuv soni to'g'ri kiritilishi shart!" });
        }
        if (isNaN(price) || price < 0) {
            return res.status(400).json({ message: "Sotish narxi to'g'ri kiritilishi shart!" });
        }
        normalizedItems.push({ product_id, qty, price });
    }

    // Bitta savdoda bir xil ombor qatorini ikki marta ko'rsatish xatolikka olib keladi
    const uniqueIds = new Set(normalizedItems.map((it) => String(it.product_id)));
    if (uniqueIds.size !== normalizedItems.length) {
        return res.status(400).json({ message: "Bir xil razmer/tovar qatori ro'yxatda bir necha marta ko'rsatilgan!" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const soldLines = [];
        let totalQty = 0;
        let totalRevenue = 0;
        let totalProfit = 0;
        let anyFullySoldOut = false;
        let firstLocalId = null;
        let firstProductName = null;

        for (const item of normalizedItems) {
            // Bu yerda product_id sifatida bazadagi haqiqiy id (aniq razmer qatori) keladi.
            // Agar local_id kelib qolsa (eski chaqiruvlar uchun moslik), eng kichik id
            // bo'yicha bitta aniq qator tanlanadi.
            const productResult = await client.query(
                `SELECT * FROM public.products WHERE (id = $1 OR local_id = $1) AND user_id = $2 ORDER BY id ASC LIMIT 1 FOR UPDATE`,
                [item.product_id, userId]
            );

            if (productResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ message: `Tovar topilmadi! (ID: ${item.product_id})` });
            }

            const product = productResult.rows[0];

            if (Number(product.quantity) < item.qty) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    message: `Omborda yetarli tovar yo'q! (${product.name}${product.size ? ' - ' + product.size : ''}: qoldiq ${product.quantity} ta)`
                });
            }

            const costPrice = Number(product.cost_price) || 0;
            const profit = (item.price - costPrice) * item.qty;
            const newQuantity = Number(product.quantity) - item.qty;

            await client.query(
                `INSERT INTO public.sales (user_id, product_id, title, quantity, cost_price, selling_price, profit)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [userId, product.id, product.name, item.qty, costPrice, item.price, profit]
            );

            let fullySoldOut = false;
            if (newQuantity === 0) {
                await client.query(`DELETE FROM public.products WHERE id = $1`, [product.id]);
                fullySoldOut = true;
                anyFullySoldOut = true;
            } else {
                await client.query(`UPDATE public.products SET quantity = $1 WHERE id = $2`, [newQuantity, product.id]);
            }

            if (firstLocalId === null) {
                firstLocalId = product.local_id;
                firstProductName = product.name;
            }

            totalQty += item.qty;
            totalRevenue += item.price * item.qty;
            totalProfit += profit;

            soldLines.push(
                `   • 📏 ${product.size || "Standart"}: ${item.qty} dona × ${formatSum(item.price)} so'm = ${formatSum(item.price * item.qty)} so'm${fullySoldOut ? " (🗑 tugadi)" : ` (qoldiq: ${newQuantity} ta)`}`
            );
        }

        const userRow = await client.query(`SELECT site_login FROM public.users WHERE id = $1`, [userId]);
        const siteLogin = userRow.rows.length > 0 ? userRow.rows[0].site_login : 'unknown';

        const isMulti = normalizedItems.length > 1;
        const titleLine = isMulti
            ? `💵 <b>TOVAR SOTILDI — ${normalizedItems.length} TA RAZMER (#${firstLocalId})</b>`
            : `💵 <b>TOVAR SOTILDI (#${firstLocalId})</b>`;

        const sellMessage =
            `${titleLine}\n━━━━━━━━━━━━━━━━━━━━\n📦 <b>Nomi:</b> ${firstProductName}\n📏 <b>Razmerlar bo'yicha:</b>\n${soldLines.join('\n')}\n━━━━━━━━━━━━━━━━━━━━\n📊 <b>Jami sotilgan:</b> ${totalQty} dona\n💰 <b>Jami tushum:</b> ${formatSum(totalRevenue)} so'm\n📈 <b>Jami foyda:</b> ${formatSum(totalProfit)} so'm\n${anyFullySoldOut ? "🗑 Ba'zi razmerlar ombordan butunlay chiqarildi\n" : ''}🎉 Tabriklaymiz, savdo amalga oshdi!`;

        await client.query(
            `INSERT INTO public.notifications (site_login, message) VALUES ($1, $2)`,
            [siteLogin, sellMessage]
        );

        await client.query('COMMIT');

        return res.json({
            message: "Tovar(lar) muvaffaqiyatli sotildi",
            totalQty,
            totalRevenue,
            totalProfit,
            profit: totalProfit,
            itemsSold: normalizedItems.length
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
// Ushbu marshrut ham eski (yagona razmer) formatni ({ product_id, remove_all,
// quantity_to_remove }) va yangi ("savatcha") formatni ({ items: [...] })
// qabul qiladi. Barcha razmerlar bitta tranzaksiya ichida qayta ishlanadi.
app.post('/api/dashboard/delete-product', authenticateToken, async (req, res) => {
    const userId = req.user.userId;

    let items = Array.isArray(req.body.items) ? req.body.items : null;
    if (!items) {
        const { product_id, remove_all, quantity_to_remove } = req.body;
        items = [{ product_id, remove_all, quantity_to_remove }];
    }

    if (items.length === 0) {
        return res.status(400).json({ message: "Kamida bitta tovar/razmer tanlanishi shart!" });
    }

    for (const raw of items) {
        if (!raw.product_id) {
            return res.status(400).json({ message: "Tovar tanlanishi shart!" });
        }
    }

    const uniqueIds = new Set(items.map((it) => String(it.product_id)));
    if (uniqueIds.size !== items.length) {
        return res.status(400).json({ message: "Bir xil razmer/tovar qatori ro'yxatda bir necha marta ko'rsatilgan!" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const removedLines = [];
        let totalRemoved = 0;
        let anyFullyRemoved = false;
        let firstLocalId = null;
        let firstProductName = null;
        let firstProductCategory = null;
        let firstProductColor = null;
        const results = [];

        for (const raw of items) {
            const productResult = await client.query(
                `SELECT * FROM public.products WHERE (id = $1 OR local_id = $1) AND user_id = $2 ORDER BY id ASC LIMIT 1 FOR UPDATE`,
                [raw.product_id, userId]
            );

            if (productResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ message: `Tovar topilmadi! (ID: ${raw.product_id})` });
            }

            const product = productResult.rows[0];
            const removeQty = raw.remove_all ? Number(product.quantity) : (parseInt(raw.quantity_to_remove) || 1);

            if (removeQty <= 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: "Olib tashlanadigan son to'g'ri kiritilishi shart!" });
            }
            if (removeQty > Number(product.quantity)) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    message: `Omborda yetarli tovar yo'q! (${product.name}${product.size ? ' - ' + product.size : ''}: qoldiq ${product.quantity} ta)`
                });
            }

            let productFullyRemoved = false;
            let newQty = Number(product.quantity) - removeQty;

            if (removeQty >= Number(product.quantity) || newQty <= 0) {
                await client.query(`DELETE FROM public.products WHERE id = $1`, [product.id]);
                productFullyRemoved = true;
                anyFullyRemoved = true;
                newQty = 0;
            } else {
                await client.query(`UPDATE public.products SET quantity = $1 WHERE id = $2`, [newQty, product.id]);
            }

            if (firstLocalId === null) {
                firstLocalId = product.local_id;
                firstProductName = product.name;
                firstProductCategory = product.category;
                firstProductColor = product.color;
            }

            totalRemoved += removeQty;
            removedLines.push(
                `   • 📏 ${product.size || "Standart"}: ${removeQty} dona olib tashlandi${productFullyRemoved ? " (🗑 butunlay tugadi)" : ` (qoldiq: ${newQty} ta)`}`
            );

            results.push({
                product_id: product.id,
                size: product.size,
                removedQty: removeQty,
                remainingQuantity: newQty,
                productFullyRemoved
            });
        }

        const userRow = await client.query(`SELECT site_login FROM public.users WHERE id = $1`, [userId]);
        const siteLogin = userRow.rows.length > 0 ? userRow.rows[0].site_login : 'unknown';

        const isMulti = items.length > 1;
        const titleLine = isMulti
            ? `📉 <b>MAHSULOT KAMAYTIRILDI / O'CHIRILDI — ${items.length} TA RAZMER (#${firstLocalId})</b>`
            : `📉 <b>MAHSULOT KAMAYTIRILDI / O'CHIRILDI (#${firstLocalId})</b>`;

        const message =
            `${titleLine}\n━━━━━━━━━━━━━━━━━━━━\n📦 <b>Nomi:</b> ${firstProductName}\n🗂 <b>Kategoriyasi:</b> ${firstProductCategory || "Yo'q"}\n🎨 <b>Rangi:</b> ${firstProductColor || "Yo'q"}\n📏 <b>Razmerlar bo'yicha:</b>\n${removedLines.join('\n')}\n━━━━━━━━━━━━━━━━━━━━\n➖ <b>Jami olib tashlandi:</b> ${totalRemoved} dona${anyFullyRemoved ? "\n🗑 Ba'zi razmerlar ombordan butunlay chiqarildi" : ''}`;

        await client.query(
            `INSERT INTO public.notifications (site_login, message) VALUES ($1, $2)`,
            [siteLogin, message]
        );

        await client.query('COMMIT');

        return res.json({
            message: "Amal(lar) bajarildi",
            totalRemoved,
            productFullySoldOut: anyFullyRemoved,
            results
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
            const message = `💸 <b>YANGI RASXOD QO'SHILDI</b>\n━━━━━━━━━━━━━━━━━━━━\n📝 <b>Tavsifi:</b> ${expense.title}\n💰 <b>Summasi:</b> ${formatSum(expense.amount)} so'm\n📅 <b>Sanasi:</b> ${new Date(expense.created_at).toISOString().split('T')[0]}\n━━━━━━━━━━━━━━━━━━━━`;

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
// 11. QR KOD ORQALI SOTISH / O'CHIRISH
// ----------------------------------------------------
const telegramEscape = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Telegramga bevosita chat_id orqali yubormaymiz.
 * Website faqat notifications jadvaliga yozadi.
 * Telegram bot esa linked_group_chat_id orqali kerakli guruhga yuboradi.
 */
const queueTelegramNotification = async (clientOrPool, siteLogin, message) => {
    if (!siteLogin) {
        console.warn('Telegram notification queue: site_login topilmadi.');
        return;
    }

    await clientOrPool.query(
        `INSERT INTO public.notifications (site_login, message, is_sent)
         VALUES ($1, $2, false)`,
        [siteLogin, message]
    );
};

app.get('/api/qr/:token', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, local_id, name, category, color, size, cost_price, quantity, qr_token
             FROM public.products WHERE qr_token = $1 LIMIT 1`,
            [req.params.token]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'QR kodi eskirgan yoki tovar topilmadi!' });
        const product = result.rows[0];
        if (Number(product.quantity) <= 0) return res.status(410).json({ message: 'Bu tovar omborda qolmagan!' });
        res.json({ product });
    } catch (err) {
        console.error('QR ma\'lumot xatosi:', err);
        res.status(500).json({ message: 'Serverda xatolik yuz berdi!' });
    }
});

app.post('/api/qr/:token/sell', async (req, res) => {
    const sellingPrice = Number(req.body?.selling_price);
    if (!Number.isFinite(sellingPrice) || sellingPrice < 0) {
        return res.status(400).json({ message: 'Sotuv narxini to\'g\'ri kiriting!' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `SELECT * FROM public.products WHERE qr_token = $1 LIMIT 1 FOR UPDATE`,
            [req.params.token]
        );
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'QR kodi eskirgan yoki tovar topilmadi!' });
        }
        const product = result.rows[0];
        const userRow = await client.query(`SELECT site_login FROM public.users WHERE id = $1`, [product.user_id]);
        const siteLogin = userRow.rows[0]?.site_login;
        const qty = 1;
        if (Number(product.quantity) < qty) {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: 'Bu tovar omborda qolmagan!' });
        }
        const cost = Number(product.cost_price) || 0;
        const totalAmount = sellingPrice * qty;
        const profit = (sellingPrice - cost) * qty;
        const newQty = Number(product.quantity) - qty;

        await client.query(
            `INSERT INTO public.sales (user_id, product_id, title, quantity, cost_price, selling_price, profit)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [product.user_id, product.id, product.name, qty, cost, sellingPrice, profit]
        );

        if (newQty === 0) {
            await client.query(`DELETE FROM public.products WHERE id = $1`, [product.id]);
        } else {
            await client.query(`UPDATE public.products SET quantity = $1 WHERE id = $2`, [newQty, product.id]);
        }

        const stats = await client.query(
            `SELECT COALESCE(SUM(quantity),0) AS sold,
                    COALESCE(SUM(quantity * selling_price),0) AS revenue,
                    COALESCE(SUM(profit),0) AS gross_profit
             FROM public.sales WHERE user_id = $1`,
            [product.user_id]
        );
        const overall = stats.rows[0];
        const expenseResult = await client.query(
            `SELECT COALESCE(SUM(amount),0) AS expense FROM public.expenses WHERE user_id = $1`,
            [product.user_id]
        );
        const totalExpense = Number(expenseResult.rows[0].expense || 0);
        const netProfit = Number(overall.gross_profit || 0) - totalExpense;
        const notification = `💰 <b>QR ORQALI SOTUV</b>\n━━━━━━━━━━━━━━━━━━━━\n📦 <b>Tovar:</b> ${telegramEscape(product.name)}\n📏 <b>Razmer:</b> ${telegramEscape(product.size || 'Standart')}\n🔢 <b>Soni:</b> 1 dona\n💵 <b>Sotuv:</b> ${formatSum(sellingPrice)} so'm\n💳 <b>Tannarx:</b> ${formatSum(cost)} so'm\n${profit >= 0 ? '📈' : '📉'} <b>${profit >= 0 ? 'Foyda' : 'Ziyon'}:</b> ${formatSum(Math.abs(profit))} so'm\n📦 <b>Qoldiq:</b> ${newQty} dona\n\n📊 <b>Umumiy tushum:</b> ${formatSum(overall.revenue)} so'm\n📈 <b>Umumiy yalpi foyda:</b> ${formatSum(overall.gross_profit)} so'm\n💸 <b>Umumiy rasxod:</b> ${formatSum(totalExpense)} so'm\n${netProfit >= 0 ? '🟢' : '🔴'} <b>Umumiy sof foyda:</b> ${formatSum(Math.abs(netProfit))} so'm${netProfit < 0 ? ' (ziyon)' : ''}`;

        await queueTelegramNotification(client, siteLogin, notification);
        await client.query('COMMIT');
        res.json({ success: true, product: { name: product.name, size: product.size, cost_price: cost }, selling_price: sellingPrice, quantity: qty, total_amount: totalAmount, profit, remaining_quantity: newQty });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('QR sotuv xatosi:', err);
        res.status(500).json({ message: 'QR orqali sotishda server xatosi!' });
    } finally {
        client.release();
    }
});

app.post('/api/qr/:token/delete', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `SELECT * FROM public.products WHERE qr_token = $1 LIMIT 1 FOR UPDATE`,
            [req.params.token]
        );
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'QR kodi eskirgan yoki tovar topilmadi!' });
        }
        const product = result.rows[0];
        const userRow = await client.query(`SELECT site_login FROM public.users WHERE id = $1`, [product.user_id]);
        const siteLogin = userRow.rows[0]?.site_login;
        await client.query(`DELETE FROM public.products WHERE id = $1`, [product.id]);

        const message = `🗑️ <b>QR ORQALI TOVAR O'CHIRILDI</b>\n━━━━━━━━━━━━━━━━━━━━\n📦 <b>Tovar:</b> ${telegramEscape(product.name)}\n📏 <b>Razmer:</b> ${telegramEscape(product.size || 'Standart')}\n🎨 <b>Rang:</b> ${telegramEscape(product.color || 'Ko\'rsatilmagan')}\n💰 <b>Tannarx:</b> ${formatSum(product.cost_price)} so'm\n🔢 <b>Ombordagi miqdor:</b> ${product.quantity} dona\n━━━━━━━━━━━━━━━━━━━━\n🗑️ Tovar ombordan chiqarildi.`;
        await queueTelegramNotification(client, siteLogin, message);
        await client.query('COMMIT');
        res.json({ success: true, message: 'Tovar ombordan o\'chirildi!' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('QR o\'chirish xatosi:', err);
        res.status(500).json({ message: 'QR orqali o\'chirishda server xatosi!' });
    } finally {
        client.release();
    }
});

// ----------------------------------------------------
// 12. BOT UCHUN DAVRLI FOYDALARni OLISH ENDPOINTI
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