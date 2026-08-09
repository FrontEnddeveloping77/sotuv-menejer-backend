const express = require('express');
const router = express.Router();

const checkAuthAndSubscription = (req, res, next) => {
    next();
};

// 1. STATISTIKA (Rasxodlar ayrib tashlangan foyda bilan)
router.get('/stats', checkAuthAndSubscription, async (req, res) => {
    try {
        const pool = req.app.get('pool');
        const userId = req.user ? req.user.userId : null;

        if (!userId) return res.status(401).json({ message: 'Foydalanuvchi aniqlanmadi!' });

        // Ombordagi tovarlar soni va qoldig'i
        const productsRes = await pool.query(
            'SELECT COUNT(*) as total_products, COALESCE(SUM(quantity), 0) as total_stock FROM products WHERE user_id = $1',
            [userId]
        );

        // SOTUV FOYDALARI
        const totalSalesRes = await pool.query(
            `SELECT 
        COALESCE(SUM(COALESCE(sell_quantity, quantity, 0)), 0) as total_sold, 
        COALESCE(SUM(COALESCE(total_amount, selling_price * COALESCE(sell_quantity, quantity, 1), sale_price * COALESCE(sell_quantity, quantity, 1), 0)), 0) as total_revenue, 
        COALESCE(SUM((COALESCE(selling_price, sale_price, 0) - COALESCE(cost_price, 0)) * COALESCE(sell_quantity, quantity, 1)), 0) as total_profit 
       FROM sales WHERE user_id = $1`,
            [userId]
        );

        const dailySalesRes = await pool.query(
            `SELECT 
        COALESCE(SUM(COALESCE(sell_quantity, quantity, 0)), 0) as daily_sold, 
        COALESCE(SUM(COALESCE(total_amount, selling_price * COALESCE(sell_quantity, quantity, 1), sale_price * COALESCE(sell_quantity, quantity, 1), 0)), 0) as daily_revenue, 
        COALESCE(SUM((COALESCE(selling_price, sale_price, 0) - COALESCE(cost_price, 0)) * COALESCE(sell_quantity, quantity, 1)), 0) as daily_profit 
       FROM sales WHERE user_id = $1 AND DATE(created_at) = CURRENT_DATE`,
            [userId]
        );

        const monthlySalesRes = await pool.query(
            `SELECT 
        COALESCE(SUM(COALESCE(sell_quantity, quantity, 0)), 0) as monthly_sold, 
        COALESCE(SUM(COALESCE(total_amount, selling_price * COALESCE(sell_quantity, quantity, 1), sale_price * COALESCE(sell_quantity, quantity, 1), 0)), 0) as monthly_revenue, 
        COALESCE(SUM((COALESCE(selling_price, sale_price, 0) - COALESCE(cost_price, 0)) * COALESCE(sell_quantity, quantity, 1)), 0) as monthly_profit 
       FROM sales WHERE user_id = $1 AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)`,
            [userId]
        );

        const yearlySalesRes = await pool.query(
            `SELECT 
        COALESCE(SUM(COALESCE(sell_quantity, quantity, 0)), 0) as yearly_sold, 
        COALESCE(SUM(COALESCE(total_amount, selling_price * COALESCE(sell_quantity, quantity, 1), sale_price * COALESCE(sell_quantity, quantity, 1), 0)), 0) as yearly_revenue, 
        COALESCE(SUM((COALESCE(selling_price, sale_price, 0) - COALESCE(cost_price, 0)) * COALESCE(sell_quantity, quantity, 1)), 0) as yearly_profit 
       FROM sales WHERE user_id = $1 AND DATE_TRUNC('year', created_at) = DATE_TRUNC('year', CURRENT_DATE)`,
            [userId]
        );

        // RASXODLAR HISOBLASH
        const dailyExpenseRes = await pool.query(
            `SELECT COALESCE(SUM(amount), 0) as daily_exp FROM expenses WHERE user_id = $1 AND DATE(created_at) = CURRENT_DATE AND expense_type = 'daily'`,
            [userId]
        );

        const monthlyExpenseRes = await pool.query(
            `SELECT COALESCE(SUM(amount), 0) as monthly_exp FROM expenses WHERE user_id = $1 AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE) AND expense_type IN ('daily', 'monthly')`,
            [userId]
        );

        const yearlyExpenseRes = await pool.query(
            `SELECT COALESCE(SUM(amount), 0) as yearly_exp FROM expenses WHERE user_id = $1 AND DATE_TRUNC('year', created_at) = DATE_TRUNC('year', CURRENT_DATE)`,
            [userId]
        );

        const totalExpenseRes = await pool.query(
            `SELECT COALESCE(SUM(amount), 0) as total_exp FROM expenses WHERE user_id = $1`,
            [userId]
        );

        const userRes = await pool.query('SELECT site_login FROM users WHERE id = $1', [userId]);

        const grossDailyProfit = parseFloat(dailySalesRes.rows[0].daily_profit) || 0;
        const grossMonthlyProfit = parseFloat(monthlySalesRes.rows[0].monthly_profit) || 0;
        const grossYearlyProfit = parseFloat(yearlySalesRes.rows[0].yearly_profit) || 0;
        const grossTotalProfit = parseFloat(totalSalesRes.rows[0].total_profit) || 0;

        const dailyExp = parseFloat(dailyExpenseRes.rows[0].daily_exp) || 0;
        const monthlyExp = parseFloat(monthlyExpenseRes.rows[0].monthly_exp) || 0;
        const yearlyExp = parseFloat(yearlyExpenseRes.rows[0].yearly_exp) || 0;
        const totalExp = parseFloat(totalExpenseRes.rows[0].total_exp) || 0;

        res.json({
            storeName: userRes.rows[0]?.site_login || 'Mening Do‘konim',
            totalProducts: parseInt(productsRes.rows[0].total_products) || 0,
            totalStock: parseInt(productsRes.rows[0].total_stock) || 0,

            totalSold: parseInt(totalSalesRes.rows[0].total_sold) || 0,
            totalRevenue: parseFloat(totalSalesRes.rows[0].total_revenue) || 0,
            totalProfit: grossTotalProfit - totalExp,
            totalExpense: totalExp,

            dailySold: parseInt(dailySalesRes.rows[0].daily_sold) || 0,
            dailyRevenue: parseFloat(dailySalesRes.rows[0].daily_revenue) || 0,
            dailyProfit: grossDailyProfit - dailyExp,
            dailyExpense: dailyExp,

            monthlySold: parseInt(monthlySalesRes.rows[0].monthly_sold) || 0,
            monthlyRevenue: parseFloat(monthlySalesRes.rows[0].monthly_revenue) || 0,
            monthlyProfit: grossMonthlyProfit - monthlyExp,
            monthlyExpense: monthlyExp,

            yearlySold: parseInt(yearlySalesRes.rows[0].yearly_sold) || 0,
            yearlyRevenue: parseFloat(yearlySalesRes.rows[0].yearly_revenue) || 0,
            yearlyProfit: grossYearlyProfit - yearlyExp,
            yearlyExpense: yearlyExp,
        });
    } catch (err) {
        console.error('Stats xatosi:', err);
        res.status(500).json({ message: 'Serverda xatolik yuz berdi' });
    }
});

// 2. TOVARLAR RO'YXATI
router.get('/products', checkAuthAndSubscription, async (req, res) => {
    try {
        const pool = req.app.get('pool');
        const userId = req.user ? req.user.userId : null;

        if (!userId) return res.status(401).json({ message: 'Foydalanuvchi aniqlanmadi!' });

        const result = await pool.query(
            'SELECT id, title, category, cost_price, color, size, quantity, description FROM products WHERE user_id = $1 ORDER BY id DESC',
            [userId]
        );

        res.json(result.rows);
    } catch (err) {
        console.error('Products get xatosi:', err);
        res.status(500).json({ message: 'Serverda xatolik yuz berdi' });
    }
});

// 3. TOVAR QO'SHISH
router.post('/products', checkAuthAndSubscription, async (req, res) => {
    try {
        const pool = req.app.get('pool');
        const userId = req.user ? req.user.userId : req.body.userId;

        if (!userId) return res.status(401).json({ message: 'Foydalanuvchi aniqlanmadi!' });

        const { title, category, cost_price, color, size, quantity, description } = req.body;

        if (!title || cost_price === undefined || cost_price === null || cost_price === '') {
            return res.status(400).json({ message: 'Tovar nomi va kelgan narxi kiritilishi shart!' });
        }

        const parsedCostPrice = parseFloat(cost_price) || 0;

        const insertQuery = `
      INSERT INTO products (user_id, title, category, cost_price, price, color, size, quantity, description)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *;
    `;

        const values = [
            userId,
            title,
            category || 'Umumiy',
            parsedCostPrice,
            parsedCostPrice,
            color ? String(color) : null,
            size ? String(size) : null,
            parseInt(quantity) || 1,
            description || '',
        ];

        const newProduct = await pool.query(insertQuery, values);

        res.status(201).json({
            success: true,
            message: 'Tovar muvaffaqiyatli saqlandi',
            product: newProduct.rows[0],
        });
    } catch (err) {
        console.error('Baza bilan bog‘liq xatolik:', err.message);
        res.status(500).json({ message: `Baza yoki serverda xatolik: ${err.message}` });
    }
});

// 4. TOVAR SOTISH
router.post('/sell', checkAuthAndSubscription, async (req, res) => {
    try {
        const pool = req.app.get('pool');
        const userId = req.user ? req.user.userId : null;

        if (!userId) return res.status(401).json({ message: 'Foydalanuvchi aniqlanmadi!' });

        const { product_id, sell_quantity, selling_price } = req.body;
        const qty = parseInt(sell_quantity) || 1;
        const sPrice = parseFloat(selling_price) || 0;
        const totalAmount = qty * sPrice;

        const productRes = await pool.query(
            'SELECT id, quantity, cost_price FROM products WHERE id = $1 AND user_id = $2',
            [product_id, userId]
        );

        if (productRes.rows.length === 0) {
            return res.status(404).json({ message: 'Tovar topilmadi!' });
        }

        const product = productRes.rows[0];

        if (parseInt(product.quantity) < qty) {
            return res.status(400).json({ message: 'Omborda yetarli tovar yo‘q!' });
        }

        await pool.query(
            `INSERT INTO sales (user_id, product_id, quantity, sell_quantity, sale_price, selling_price, total_amount, cost_price, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
            [
                userId,
                parseInt(product_id),
                qty,
                qty,
                sPrice,
                sPrice,
                totalAmount,
                parseFloat(product.cost_price) || 0,
            ]
        );

        await pool.query(
            'UPDATE products SET quantity = quantity - $1 WHERE id = $2',
            [qty, parseInt(product_id)]
        );

        res.json({ success: true, message: 'Sotuv amalga oshirildi' });
    } catch (err) {
        console.error('Sotuv xatosi:', err.message);
        res.status(500).json({ message: `Sotuvda xatolik: ${err.message}` });
    }
});

// 5. TOVARNI OLIB TASHLASH / O'CHIRISH
router.post('/delete-product', checkAuthAndSubscription, async (req, res) => {
    try {
        const pool = req.app.get('pool');
        const userId = req.user ? req.user.userId : null;

        if (!userId) return res.status(401).json({ message: 'Foydalanuvchi aniqlanmadi!' });

        const { product_id, remove_all, quantity_to_remove } = req.body;

        if (!product_id) {
            return res.status(400).json({ message: 'Tovar tanlanmagan!' });
        }

        const productRes = await pool.query(
            'SELECT id, quantity FROM products WHERE id = $1 AND user_id = $2',
            [product_id, userId]
        );

        if (productRes.rows.length === 0) {
            return res.status(404).json({ message: 'Tovar topilmadi!' });
        }

        const currentQty = parseInt(productRes.rows[0].quantity) || 0;
        const qtyToRemove = parseInt(quantity_to_remove) || 0;

        await pool.query('UPDATE sales SET product_id = NULL WHERE product_id = $1 AND user_id = $2', [product_id, userId]);

        if (remove_all || qtyToRemove >= currentQty) {
            await pool.query('DELETE FROM products WHERE id = $1 AND user_id = $2', [product_id, userId]);
            return res.json({ success: true, message: "Tovar ombordan to'liq o'chirildi!" });
        } else {
            await pool.query(
                'UPDATE products SET quantity = quantity - $1 WHERE id = $2 AND user_id = $3',
                [qtyToRemove, product_id, userId]
            );
            return res.json({ success: true, message: `${qtyToRemove} ta tovar ombordan olib tashlandi!` });
        }
    } catch (err) {
        console.error('Tovarni o‘chirishda xatolik:', err.message);
        res.status(500).json({ message: `Xatolik: ${err.message}` });
    }
});

// 6. RASXOD QO'SHISH
router.post('/expenses', checkAuthAndSubscription, async (req, res) => {
    try {
        const pool = req.app.get('pool');
        const userId = req.user ? req.user.userId : null;

        if (!userId) return res.status(401).json({ message: 'Foydalanuvchi aniqlanmadi!' });

        const { title, amount, expense_type } = req.body;

        if (!title || !amount || !expense_type) {
            return res.status(400).json({ message: 'Barcha maydonlarni to‘ldiring!' });
        }

        await pool.query(
            `INSERT INTO expenses (user_id, title, amount, expense_type, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
            [userId, title, parseFloat(amount), expense_type]
        );

        res.status(201).json({ success: true, message: 'Rasxod muvaffaqiyatli saqlandi' });
    } catch (err) {
        console.error('Rasxod saqlash xatosi:', err.message);
        res.status(500).json({ message: `Serverda xatolik: ${err.message}` });
    }
});

module.exports = router;