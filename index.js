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
    activePlanTier: { type: String, default: 'NONE' },
    userDepositAmount: { type: Number, default: 0.00 },
    miningSpeedPerSec: { type: Number, default: 0.0000 },
    activeDirectsCount: { type: Number, default: 0 },

    promoBonusBalance: { type: Number, default: 0.0100 },
    directReferralBonus: { type: Number, default: 0.0000 },
    teamReferralBonus: { type: Number, default: 0.0000 },
    teamOverrideBonus: { type: Number, default: 0.0000 },
    rankRoyaltyBonus: { type: Number, default: 0.0000 },
    highestAchievedRank: { type: String, default: 'NO RANK' },

    levelVolumes: { type: [Number], default: Array(26).fill(0.0) },
    levelMembersData: { type: mongoose.Schema.Types.Mixed, default: {} },

    userStrongestDone: { type: Number, default: 0.0 },
    userOtherDone: { type: Number, default: 0.0 },

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
        const { 
            telegramId, 
            username, 
            firstName, 
            minedSolBalance, 
            availableSolBalance, 
            totalSelfFarmingClaimed, 
            activePlanTier, 
            userDepositAmount, 
            miningSpeedPerSec, // Added here
            promoBonusBalance 
        } = req.body;

        if (!telegramId) {
            return res.status(400).json({ error: 'Telegram ID is required' });
        }

        // Generate dummy test users if not existing
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
            user = new User({ 
                telegramId, 
                username: username || '', 
                firstName: firstName || '',
                activePlanTier: 'NONE',
                userDepositAmount: 0.00,
                promoBonusBalance: 0.0100
            });
        } else {
            // --- OFFLINE AUTO-MINING / TIME-BASED CALCULATION ---
            if (user.lastUpdated && user.activePlanTier && user.activePlanTier !== 'NONE') {
                const now = Date.now();
                const diffSeconds = (now - new Date(user.lastUpdated).getTime()) / 1000;
                
                if (diffSeconds > 0 && user.miningSpeedPerSec > 0) {
                    const offlineMined = diffSeconds * user.miningSpeedPerSec;
                    user.minedSolBalance = (user.minedSolBalance || 0) + offlineMined;
                }
            }
        }

        // Username preservation
        if (username && typeof username === 'string' && username.trim() !== '' && username !== 'undefined') {
            user.username = username;
        }

        if (firstName && typeof firstName === 'string' && firstName.trim() !== '' && firstName !== 'undefined') {
            user.firstName = firstName;
        }

        // Safe numeric assignments
        if (minedSolBalance !== undefined) user.minedSolBalance = minedSolBalance;
        if (availableSolBalance !== undefined) user.availableSolBalance = availableSolBalance;
        if (totalSelfFarmingClaimed !== undefined) user.totalSelfFarmingClaimed = Math.max(user.totalSelfFarmingClaimed || 0, totalSelfFarmingClaimed);
        if (miningSpeedPerSec !== undefined) user.miningSpeedPerSec = miningSpeedPerSec; // Added here

        if (activePlanTier && activePlanTier !== 'NONE') {
            user.activePlanTier = activePlanTier;
        }

        if (userDepositAmount !== undefined) user.userDepositAmount = Math.max(user.userDepositAmount || 0, userDepositAmount);
        if (promoBonusBalance !== undefined) user.promoBonusBalance = Math.max(user.promoBonusBalance || 0.0100, promoBonusBalance);

        // Auto-Topup Trigger
        if (user.promoBonusBalance >= 0.10 && (!user.activePlanTier || user.activePlanTier === 'NONE')) {
            user.activePlanTier = 'STARTER';
            user.userDepositAmount = 0.10;
        }

        const allTestUsers = await User.find({ telegramId: /^test_user_/ });
        let dummyMembersList = allTestUsers.map(u => ({
            name: `@${u.username}`,
            deposit: "0.10 SOL",
            date: new Date().toISOString().split('T')[0]
        }));

        if (!user.levelMembersData || Object.keys(user.levelMembersData).length === 0) {
            user.levelMembersData = { '1': dummyMembersList };
        } else if (!user.levelMembersData['1'] || user.levelMembersData['1'].length === 0) {
            user.levelMembersData['1'] = dummyMembersList;
        }

        // Calculate Level Volumes and Total Team Members Dynamically
        let calculatedLevelVolumes = Array(26).fill(0.0);
        let totalTeamMembersCount = 0;
        let directTeamVol = 0;
        let overallTeamVol = 0;

        for (let lvl = 1; lvl <= 25; lvl++) {
            let members = (user.levelMembersData && user.levelMembersData[lvl]) || [];
            let lvlSum = 0;

            members.forEach(m => {
                let depStr = (typeof m === 'string') ? m : (m.deposit || "0.10");
                let numMatch = String(depStr).match(/[\d.]+/);
                let val = numMatch ? parseFloat(numMatch[0]) : 0.10;
                lvlSum += val;
            });

            calculatedLevelVolumes[lvl] = lvlSum;
            totalTeamMembersCount += members.length;
            overallTeamVol += lvlSum;
            if (lvl === 1) directTeamVol = lvlSum;
        }

        user.levelVolumes = calculatedLevelVolumes;
        user.activeDirectsCount = (user.levelMembersData && user.levelMembersData['1']) ? user.levelMembersData['1'].length : 0;
        user.lastUpdated = Date.now();
        await user.save();

        const finalUsername = user.username || username || '';

        return res.json({ 
            success: true, 
            user: {
                telegramId: user.telegramId,
                username: finalUsername,
                firstName: user.firstName || firstName || '',
                minedSolBalance: user.minedSolBalance || 0,
                availableSolBalance: user.availableSolBalance || 0,
                totalSelfFarmingClaimed: user.totalSelfFarmingClaimed || 0,
                activePlanTier: user.activePlanTier || 'NONE',
                userDepositAmount: user.userDepositAmount || 0,
                miningSpeedPerSec: user.miningSpeedPerSec || 0,
                activeDirectsCount: user.activeDirectsCount || 0,
                directTeamVolume: directTeamVol,
                totalTeamMembersCount: totalTeamMembersCount,
                totalTeamVolume: overallTeamVol,
                promoBonusBalance: user.promoBonusBalance || 0.0100,
                userStrongestDone: user.userStrongestDone || 0,
                userOtherDone: user.userOtherDone || 0,
                totalEarnedAmount: user.totalEarnedAmount || 0,
                levelVolumes: user.levelVolumes,
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
