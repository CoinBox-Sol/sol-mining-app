const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());
console.log('CORS is enabled for all origins');

const PORT = process.env.PORT || 3000;

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB Connected Successfully!'))
    .catch(err => console.error('MongoDB Connection Error:', err));

// Complete User Schema matching index.html exact expectations
const userSchema = new mongoose.Schema({
    telegramId: { type: String, required: true, unique: true },
    username: { type: String, default: '' },
    firstName: { type: String, default: '' },
    
    // Balances & Mining State
    minedSolBalance: { type: Number, default: 0.0000 },
    availableSolBalance: { type: Number, default: 0.0000 },
    totalSelfFarmingClaimed: { type: Number, default: 0.0000 },
    activePlanTier: { type: String, default: 'STARTER' },
    userDepositAmount: { type: Number, default: 0.10 },
    miningSpeedPerSec: { type: Number, default: 0.0000 },
    activeDirectsCount: { type: Number, default: 100 },

    // Promo, Bonuses & Ranks
    promoBonusBalance: { type: Number, default: 0.1000 },
    directReferralBonus: { type: Number, default: 0.5000 },
    teamReferralBonus: { type: Number, default: 0.0000 },
    teamOverrideBonus: { type: Number, default: 0.0000 },
    rankRoyaltyBonus: { type: Number, default: 0.0000 },
    highestAchievedRank: { type: String, default: 'STAR RANK' },

    // Team Network Volumes & Level-wise Member Details (25 Levels)
    levelVolumes: { type: [Number], default: Array(26).fill(0.0) },
    levelMembersData: { type: mongoose.Schema.Types.Mixed, default: {} },

    // Rank Business Legs
    userStrongestDone: { type: Number, default: 4.0 },
    userOtherDone: { type: Number, default: 6.0 },

    // Profile Settings
    profileName: { type: String, default: '' },
    profileMobile: { type: String, default: '' },
    profileEmail: { type: String, default: '' },
    profileSolAddress: { type: String, default: '' },

    totalEarnedAmount: { type: Number, default: 0.0000 },
    lastUpdated: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Universal Sync Endpoint: Auto-generates dummy users & forces 100 Directs + Team Volume to logged-in Telegram User
app.post('/api/user/sync', async (req, res) => {
    try {
        const { 
            telegramId, 
            username, 
            firstName
        } = req.body;

        if (!telegramId) {
            return res.status(400).json({ error: 'Telegram ID is required' });
        }

        // 1. Generate 100 Dummy Users in DB if missing
        for (let i = 1; i <= 100; i++) {
            let dummyId = `test_user_${i}`;
            let existingDummy = await User.findOne({ telegramId: dummyId });
            if (!existingDummy) {
                let dummyUser = new User({
                    telegramId: dummyId,
                    username: `user_${i}`,
                    firstName: `TestUser ${i}`,
                    profileName: `User ${i}`,
                    promoBonusBalance: 0.10,
                    activePlanTier: 'STARTER',
                    userDepositAmount: 0.10
                });
                await dummyUser.save();
            }
        }

        // 2. Fetch or create current active Telegram user
        let user = await User.findOne({ telegramId });

        if (!user) {
            user = new User({
                telegramId,
                username: username || '',
                firstName: firstName || '',
                profileName: username ? `@${username}` : (firstName || ''),
            });
        }

        // 3. Prepare Dummy Members Array for Level 1
        const allTestUsers = await User.find({ telegramId: /^test_user_/ });
        
        let dummyMembersList = allTestUsers.map(u => ({
            name: `@${u.username}`,
            deposit: "0.10 SOL",
            date: new Date().toISOString().split('T')[0]
        }));

        // 4. Force override user data to reflect 100 Directs and 10.00 SOL volume
        user.activeDirectsCount = 100;
        user.promoBonusBalance = 0.10;
        if (user.activePlanTier === 'NONE' || !user.activePlanTier) {
            user.activePlanTier = 'STARTER';
            user.userDepositAmount = 0.10;
        }

        let lVolumes = Array(26).fill(0.0);
        lVolumes[1] = 10.0; // 100 * 0.10 SOL = 10 SOL Level 1 Volume
        user.levelVolumes = lVolumes;

        user.levelMembersData = {
            '1': dummyMembersList
        };

        if (username) user.username = username;
        if (firstName) user.firstName = firstName;
        user.lastUpdated = Date.now();

        await user.save();

        // 5. Send exact JSON structure expected by index.html window.onload fetch handler
        return res.json({ 
            success: true, 
            user: {
                telegramId: user.telegramId,
                username: user.username,
                firstName: user.firstName,
                minedSolBalance: user.minedSolBalance || 0,
                availableSolBalance: user.availableSolBalance || 0,
                totalSelfFarmingClaimed: user.totalSelfFarmingClaimed || 0,
                activePlanTier: user.activePlanTier,
                userDepositAmount: user.userDepositAmount || 0.10,
                miningSpeedPerSec: user.miningSpeedPerSec || 0,
                activeDirectsCount: 100,
                promoBonusBalance: 0.1000,
                userStrongestDone: user.userStrongestDone || 4.0,
                userOtherDone: user.userOtherDone || 6.0,
                totalEarnedAmount: user.totalEarnedAmount || 0,
                levelVolumes: user.levelVolumes,
                levelMembersData: user.levelMembersData
            } 
        });

    } catch (error) {
        console.error('Sync API Error:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.get('/', (req, res) => {
    res.send('SolMiningBot Express Backend Live!');
});

app.listen(PORT, () => {
    console.log('Server started on port ' + PORT);
});
