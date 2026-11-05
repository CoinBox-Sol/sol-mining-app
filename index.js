const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());
console.log('CORS is enabled for all origins');

const PORT = process.env.PORT || 3000;

const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB Connected Successfully!'))
    .catch(err => console.error('MongoDB Connection Error:', err));

const userSchema = new mongoose.Schema({
    telegramId: { type: String, required: true, unique: true },
    username: { type: String, default: '' },
    firstName: { type: String, default: '' },
    
    minedSolBalance: { type: Number, default: 0.0000 },
    availableSolBalance: { type: Number, default: 0.0000 },
    totalSelfFarmingClaimed: { type: Number, default: 0.0000 },
    activePlanTier: { type: String, default: 'STARTER' },
    userDepositAmount: { type: Number, default: 0.10 },
    miningSpeedPerSec: { type: Number, default: 0.0000 },
    activeDirectsCount: { type: Number, default: 100 },

    promoBonusBalance: { type: Number, default: 0.1000 },
    directReferralBonus: { type: Number, default: 0.5000 },
    teamReferralBonus: { type: Number, default: 0.0000 },
    teamOverrideBonus: { type: Number, default: 0.0000 },
    rankRoyaltyBonus: { type: Number, default: 0.0000 },
    highestAchievedRank: { type: String, default: 'STAR RANK' },

    levelVolumes: { type: [Number], default: Array(26).fill(0.0) },
    levelMembersData: { type: mongoose.Schema.Types.Mixed, default: {} },

    userStrongestDone: { type: Number, default: 4.0 },
    userOtherDone: { type: Number, default: 6.0 },

    profileName: { type: String, default: '' },
    profileMobile: { type: String, default: '' },
    profileEmail: { type: String, default: '' },
    profileSolAddress: { type: String, default: '' },

    totalEarnedAmount: { type: Number, default: 0.0000 },
    lastUpdated: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

app.post('/api/user/sync', async (req, res) => {
    try {
        const { telegramId, username, firstName } = req.body;

        if (!telegramId) {
            return res.status(400).json({ error: 'Telegram ID is required' });
        }

        // Generate 100 dummy users
        for (let i = 1; i <= 100; i++) {
            let dummyId = `test_user_${i}`;
            let existing = await User.findOne({ telegramId: dummyId });
            if (!existing) {
                await new User({
                    telegramId: dummyId,
                    username: `user_${i}`,
                    firstName: `TestUser ${i}`,
                    profileName: `User ${i}`,
                    activePlanTier: 'STARTER',
                    userDepositAmount: 0.10
                }).save();
            }
        }

        let user = await User.findOne({ telegramId });
        if (!user) {
            user = new User({ telegramId, username, firstName });
        }

        const allTestUsers = await User.find({ telegramId: /^test_user_/ });
        let dummyMembersList = allTestUsers.map(u => ({
            name: `@${u.username}`,
            deposit: "0.10 SOL",
            date: new Date().toISOString().split('T')[0]
        }));

        user.activeDirectsCount = 100;
        user.activePlanTier = 'STARTER';
        user.userDepositAmount = 0.10;
        user.promoBonusBalance = 0.10;
        
        let lVolumes = Array(26).fill(0.0);
        lVolumes[1] = 10.0;
        user.levelVolumes = lVolumes;

        user.levelMembersData = { '1': dummyMembersList };
        if (username) user.username = username;
        if (firstName) user.firstName = firstName;
        await user.save();

        // Send direct forced response so frontend renders it instantly
        return res.json({ 
            success: true, 
            user: {
                telegramId: user.telegramId,
                username: user.username,
                firstName: user.firstName,
                minedSolBalance: user.minedSolBalance || 0,
                availableSolBalance: user.availableSolBalance || 0,
                totalSelfFarmingClaimed: user.totalSelfFarmingClaimed || 0,
                activePlanTier: 'STARTER',
                userDepositAmount: 0.10,
                miningSpeedPerSec: user.miningSpeedPerSec || 0,
                activeDirectsCount: 100,
                promoBonusBalance: 0.1000,
                userStrongestDone: 4.0,
                userOtherDone: 6.0,
                totalEarnedAmount: user.totalEarnedAmount || 0,
                levelVolumes: lVolumes,
                levelMembersData: user.levelMembersData
            } 
        });

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
