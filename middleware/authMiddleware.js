const jwt = require('jsonwebtoken');

// Eslatma: Baza ulanishingiz qay yerda bo'lsa, o'sha faylni ko'rsatish kerak.
// Agar db ulanishi server.js da bo'lsa yoki pg Pool ishlatayotgan bo'lsangiz:
const checkAuthAndSubscription = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Token topilmadi!' });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret_key');
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ message: 'Token yaroqsiz yoki muddati o‘tgan!' });
    }
};

module.exports = checkAuthAndSubscription;