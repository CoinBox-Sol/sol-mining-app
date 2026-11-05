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

// Complete User Schema aligned with index.html state variables & multi-level team override / rank legs
const userSchema = new mongoose.Schema({
    telegramId: { type: String, required: true, unique: true },
    username: { type: String },
    firstName: { type: String },
    
    // Balances & Mining State
    minedSolBalance: { type: Number, default: 0.0000 },
    availableSolBalance: { type: Number, default: 0.0000 },
    totalSelfFarmingClaimed: { type: Number, default: 0.0000 },
    activePlanTier: { type: String, default: 'NONE' },
    userDepositAmount: { type: Number, default: 0.00 },
    miningSpeedPerSec: { type: Number, default: 0.0000 },
    activeDirectsCount: { type: Number, default: 0 },

    // Promo, Bonuses & Ranks
    promoBonusBalance: { type: Number, default: 0.0100 },
    directReferralBonus: { type: Number, default: 0.0000 },
    teamReferralBonus: { type: Number, default: 0.0000 },
    teamOverrideBonus: { type: Number, default: 0.0000 },
    rankRoyaltyBonus: { type: Number, default: 0.0000 },
    highestAchievedRank: { type: String, default: 'NO RANK' },

    // Team Network Volumes & Level-wise Member Details (25 Levels + Total Volume)
    levelVolumes: { type: [Number], default: Array(26).fill(0.0) },
    levelMembersData: { type: mongoose.Schema.Types.Mixed, default: {} },

    // Rank Business Legs (Strongest Leg 40% & Other Legs 60%)
    userStrongestDone: { type: Number, default: 0.0 },
    userOtherDone: { type: Number, default: 0.0 },

    // Profile Settings
    profileName: { type: String, default: '' },
    profileMobile: { type: String, default: '' },
    profileEmail: { type: String, default: '' },
    profileSolAddress: { type: String, default: '' },

    // Capping & Total Earned
    totalEarnedAmount: { type: Number, default: 0.0000 },

    lastUpdated: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Comprehensive Sync & State Persistence API Endpoint
app.post('/api/user/sync', async (req, res) => {
    try {
        const { 
            telegramId, 
            username, 
            firstName, 
            startParam,
            minedSolBalance,
            availableSolBalance,
            totalSelfFarmingClaimed,
            activePlanTier,
            userDepositAmount,
            miningSpeedPerSec,
            activeDirectsCount,
            promoBonusBalance,
            directReferralBonus,
            teamReferralBonus,
            teamOverrideBonus,
            rankRoyaltyBonus,
            highestAchievedRank,
            levelVolumes,
            levelMembersData,
            userStrongestDone,
            userOtherDone,
            profileName,
            profileMobile,
            profileEmail,
            profileSolAddress,
            totalEarnedAmount
        } = req.body;

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
                profileName: username ? `@${username}` : (firstName ? firstName : ''),
                promoBonusBalance: 0.0100
            });

            // Handle Sponsor / Referral logic if startParam exists
            if (startParam && startParam !== telegramId) {
                let sponsor = await User.findOne({ telegramId: startParam });
                if (sponsor) {
                    sponsor.promoBonusBalance = Math.min(0.10, sponsor.promoBonusBalance + 0.01);
                    sponsor.activeDirectsCount += 1;
                    
                    if (sponsor.promoBonusBalance >= 0.10) {
                        sponsor.activePlanTier = 'STARTER';
                        sponsor.userDepositAmount = 0.10;
                    }
                    await sponsor.save();
                }
            }
        } else {
            // Persist all incoming live states from frontend safely without resetting
            if (username) user.username = username;
            if (firstName) user.firstName = firstName;
            
            if (minedSolBalance !== undefined && minedSolBalance >= user.minedSolBalance) {
                user.minedSolBalance = minedSolBalance;
            }
            if (availableSolBalance !== undefined) user.availableSolBalance = availableSolBalance;
            if (totalSelfFarmingClaimed !== undefined) user.totalSelfFarmingClaimed = totalSelfFarmingClaimed;
            if (activePlanTier !== undefined) user.activePlanTier = activePlanTier;
            if (userDepositAmount !== undefined) user.userDepositAmount = userDepositAmount;
            if (miningSpeedPerSec !== undefined) user.miningSpeedPerSec = miningSpeedPerSec;
            if (activeDirectsCount !== undefined) user.activeDirectsCount = activeDirectsCount;

            if (promoBonusBalance !== undefined) user.promoBonusBalance = promoBonusBalance;
            if (directReferralBonus !== undefined) user.directReferralBonus = directReferralBonus;
            if (teamReferralBonus !== undefined) user.teamReferralBonus = teamReferralBonus;
            if (teamOverrideBonus !== undefined) user.teamOverrideBonus = teamOverrideBonus;
            if (rankRoyaltyBonus !== undefined) user.rankRoyaltyBonus = rankRoyaltyBonus;
            if (highestAchievedRank !== undefined) user.highestAchievedRank = highestAchievedRank;

            // Save Level-wise override volumes and member details securely
            if (levelVolumes !== undefined) user.levelVolumes = levelVolumes;
            if (levelMembersData !== undefined) user.levelMembersData = levelMembersData;

            // Save Rank Strongest Leg (40%) and Other Legs (60%) business data
            if (userStrongestDone !== undefined) user.userStrongestDone = userStrongestDone;
            if (userOtherDone !== undefined) user.userOtherDone = userOtherDone;

            if (profileName !== undefined) user.profileName = profileName;
            if (profileMobile !== undefined) user.profileMobile = profileMobile;
            if (profileEmail !== undefined) user.profileEmail = profileEmail;
            if (profileSolAddress !== undefined) user.profileSolAddress = profileSolAddress;

            if (totalEarnedAmount !== undefined) user.totalEarnedAmount = totalEarnedAmount;
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

// Test route to generate 100 dummy users instantly for testing
app.get('/api/test/generate-users', async (req, res) => {
    try {
        let sponsorId = "5939907983"; // Aapki admin ID as sponsor
        for (let i = 1; i <= 100; i++) {
            let dummyId = `test_user_${i}`;
            let existing = await User.findOne({ telegramId: dummyId });
            if (!existing) {
                let newUser = new User({
                    telegramId: dummyId,
                    username: `user_${i}`,
                    firstName: `TestUser ${i}`,
                    profileName: `User ${i}`,
                    promoBonusBalance: 0.10,
                    activePlanTier: 'STARTER'
                });
                await newUser.save();

                // Sponsor ke liye direct refs aur promo balance update karna
                let sponsor = await User.findOne({ telegramId: sponsorId });
                if (sponsor) {
                    sponsor.activeDirectsCount += 1;
                    sponsor.promoBonusBalance += 0.01;
                    await sponsor.save();
                }
            }
        }
        res.json({ success: true, message: "100 dummy users generated and linked successfully!" });
    } catch (err) {
        console.error("Test generation error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log('Server is running on port ' + PORT);
});
