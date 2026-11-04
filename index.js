const express = require('express');
const mongoose = require('mongoose');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB Connected Successfully!'))
    .catch(err => console.error('MongoDB Connection Error:', err));

// User Schema & Model with Referral, Promo Balance, and Direct Count
const userSchema = new mongoose.Schema({
    telegramId: { type: String, required: true, unique: true },
    username: { type: String },
    firstName: { type: String },
    minedBalance: { type: Number, default: 0.000146 },
    promoBalance: { type: Number, default: 0 },
    referredBy: { type: String, default: null },
    directCount: { type: Number, default: 0 },
    hashrate: { type: String, default: '2.0% / 24h' },
    lastUpdated: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Sync & Referral API Endpoint
app.post('/api/user/sync', async (req, res) => {
    try {
        const { telegramId, username, firstName, startParam } = req.body;

        if (!telegramId) {
            return res.status(400).json({ error: 'Telegram ID is required' });
        }

        let user = await User.findOne({ telegramId });

        if (!user) {
            // New user registration
            user = new User({
                telegramId,
                username,
                firstName,
                minedBalance: 0.000146,
                promoBalance: 0.01, // Joining promo bonus
                referredBy: startParam || null
            });

            // If user joined via someone's referral link (startParam contains sponsor's telegramId)
            if (startParam && startParam !== telegramId) {
                let sponsor = await User.findOne({ telegramId: startParam });
                if (sponsor) {
                    sponsor.promoBalance += 0.01; // Sponsor gets 0.01 SOL promo balance
                    sponsor.directCount += 1;     // Sponsor's direct members count increases

                    // Check Auto-Topup for Sponsor if promo balance reaches 0.10 SOL
                    if (sponsor.promoBalance >= 0.10) {
                        sponsor.minedBalance += sponsor.promoBalance;
                        sponsor.promoBalance = 0;
                    }
                    await sponsor.save();
                }
            }
        } else {
            // Update existing user details if changed
            if (username) user.username = username;
            if (firstName) user.firstName = firstName;
        }

        // Check Auto-Topup for current user if promo balance reaches 0.10 SOL
        if (user.promoBalance >= 0.10) {
            user.minedBalance += user.promoBalance;
            user.promoBalance = 0;
        }

        user.lastUpdated = Date.now();
        await user.save();

        res.json({ success: true, user });
    } catch (error) {
        console.error('Sync Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.get('/', (req, res) => {
    res.send('SolMiningBot Server is Running Live!');
});

app.listen(PORT, () => {
    console.log('Server is running on port ' + PORT);
});
