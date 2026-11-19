const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const bs58 = require('bs58');
const { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } = require('@solana/web3.js');

const app = express();
app.use(express.json());
app.use(cors());

const upload = multer({ storage: multer.memoryStorage() });

console.log('CORS is enabled for all origins');

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

let adminKeypair;
try {
    const secretKeyString = process.env.WALLET_PRIVATE_KEY;
    if (secretKeyString) {
        let secretKey;
        if (secretKeyString.trim().startsWith('[')) {
            secretKey = Uint8Array.from(JSON.parse(secretKeyString));
        } else {
            secretKey = bs58.decode(secretKeyString.trim());
        }
        adminKeypair = Keypair.fromSecretKey(secretKey);
        console.log('Admin Hot Wallet Loaded Successfully:', adminKeypair.publicKey.toBase58());
    } else {
        console.warn('Warning: WALLET_PRIVATE_KEY is not set in environment variables.');
    }
} catch (err) {
    console.error('Wallet Initialization Error: Check WALLET_PRIVATE_KEY format in Render env variables.', err.message);
}

mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB Connected Successfully!'))
    .catch(err => console.error('MongoDB Connection Error:', err));

const userSchema = new mongoose.Schema({
    telegramId: { type: String, required: true, unique: true },
    username: { type: String, default: '' },
    firstName: { type: String, default: '' },
    sponsor: { type: String, default: 'None' },
    isBlocked: { type: Boolean, default: false },
    
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

function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanSponsorRaw(sponsorVal) {
    if (!sponsorVal) return 'None';
    const clean = String(sponsorVal).replace(/^@+/, '').trim();
    if (!clean || clean.toLowerCase() === 'none' || clean.toLowerCase() === 'null') return 'None';
    return clean;
}

function cleanSponsorDisplay(sponsorVal) {
    const clean = cleanSponsorRaw(sponsorVal);
    if (clean === 'None') return 'None';
    return /^\d+$/.test(clean) ? clean : `@${clean}`;
}

async function findUserByIdentifier(identifier) {
    if (!identifier) return null;
    const clean = String(identifier).replace(/^@+/, '').trim();
    if (!clean || clean.toLowerCase() === 'none') return null;

    return await User.findOne({
        $or: [
            { telegramId: clean },
            { username: { $regex: new RegExp('^' + escapeRegex(clean) + '$', 'i') } }
        ]
    });
}

function normalizeHandle(val) {
    return String(val || '').replace(/^@+/, '').trim().toLowerCase();
}

function getUserIdentifiersSet(userDoc) {
    const set = new Set();
    if (!userDoc) return set;
    if (userDoc.telegramId) set.add(normalizeHandle(userDoc.telegramId));
    if (userDoc.username) set.add(normalizeHandle(userDoc.username));
    return set;
}

function getDownlineByLevels(allUsers, rootIdentifiersSet, maxLevel = 25) {
    const levelsMap = {};
    const visitedIds = new Set();

    for (const u of allUsers) {
        if (rootIdentifiersSet.has(normalizeHandle(u.telegramId)) || (u.username && rootIdentifiersSet.has(normalizeHandle(u.username)))) {
            if (u.telegramId) visitedIds.add(String(u.telegramId).trim());
        }
    }

    let currentSponsors = Array.from(rootIdentifiersSet).filter(Boolean);

    for (let lvl = 1; lvl <= maxLevel; lvl++) {
        if (currentSponsors.length === 0) {
            levelsMap[lvl] = [];
            continue;
        }

        const sponsorSet = new Set(currentSponsors);
        const levelUsers = [];
        const nextSponsors = [];

        for (const candidate of allUsers) {
            const candidateId = candidate.telegramId ? String(candidate.telegramId).trim() : '';
            if (!candidateId || visitedIds.has(candidateId)) continue;

            const spClean = normalizeHandle(candidate.sponsor);
            if (!spClean || spClean === 'none') continue;

            if (sponsorSet.has(spClean)) {
                visitedIds.add(candidateId);
                levelUsers.push(candidate);
                if (candidate.telegramId) nextSponsors.push(normalizeHandle(candidate.telegramId));
                if (candidate.username) nextSponsors.push(normalizeHandle(candidate.username));
            }
        }

        levelsMap[lvl] = levelUsers.map(d => ({
            telegramId: d.telegramId,
            username: d.username || '',
            name: d.profileName || (d.username ? `@${d.username.replace(/^@+/, '')}` : (d.firstName || `User_${String(d.telegramId).slice(-4)}`)),
            deposit: `${(d.userDepositAmount || 0).toFixed(2)} SOL`,
            depositAmount: d.userDepositAmount || 0,
            date: new Date(d.lastUpdated || Date.now()).toISOString().split('T')[0],
            plan: d.activePlanTier || 'NONE',
            level: lvl
        }));

        currentSponsors = nextSponsors;
    }

    return levelsMap;
}

async function recalculateUserLegs(user) {
    try {
        const usernameClean = user.username ? user.username.replace(/^@+/, '').trim() : '';
        const telegramIdStr = user.telegramId ? user.telegramId.toString() : '';

        const directs = await User.find({
            $or: [
                { sponsor: telegramIdStr },
                ...(usernameClean ? [
                    { sponsor: usernameClean },
                    { sponsor: `@${usernameClean}` },
                    { sponsor: new RegExp('^@*' + escapeRegex(usernameClean) + '$', 'i') }
                ] : [])
            ]
        });

        if (!directs || directs.length === 0) {
            user.userStrongestDone = 0.0;
            user.userOtherDone = 0.0;
            user.activeDirectsCount = 0;
            user.directReferralBonus = 0.0;
            return;
        }

        const activeDirects = directs.filter(d => (d.userDepositAmount || 0) > 0);
        user.activeDirectsCount = activeDirects.length;

        const expectedPromo = 0.01 + (directs.length * 0.01);
        if (user.promoBonusBalance < expectedPromo && user.promoBonusBalance < 0.10) {
            user.promoBonusBalance = expectedPromo;
        }

        const totalDirectDeposit = directs.reduce((acc, d) => acc + (d.userDepositAmount || 0), 0);
        user.directReferralBonus = totalDirectDeposit * 0.05;

        const directVolumes = directs.map(d => (d.userDepositAmount || 0));

        if (directVolumes.length === 0) {
            user.userStrongestDone = 0.0;
            user.userOtherDone = 0.0;
            return;
        }

        directVolumes.sort((a, b) => b - a);

        user.userStrongestDone = directVolumes[0];
        user.userOtherDone = directVolumes.slice(1).reduce((acc, val) => acc + val, 0.0);
    } catch (err) {
        console.error('Error recalculating legs:', err);
    }
}

async function recalculateSponsorByRef(sponsorRef) {
    const sponsorDoc = await findUserByIdentifier(sponsorRef);
    if (sponsorDoc) {
        await recalculateUserLegs(sponsorDoc);
        sponsorDoc.lastUpdated = Date.now();
        await sponsorDoc.save();
    }
}

function extractReferralCode(body) {
    const raw = body.startParam || body.startapp || body.ref || body.referral || body.sponsor || body.start || null;
    if (!raw) return null;
    const str = String(raw).trim();
    if (!str || str.toLowerCase() === 'none' || str.toLowerCase() === 'null' || str.toLowerCase() === 'undefined') {
        return null;
    }
    return str.replace(/^(ref_|start_|sponsor_)/i, '').trim() || null;
}

app.post('/api/user/claim', async (req, res) => {
    try {
        const { telegramId, claimedAmount } = req.body;
        if (!telegramId) {
            return res.status(400).json({ success: false, error: 'Telegram ID is required' });
        }

        let user = await User.findOne({ telegramId });
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        let amount = parseFloat(claimedAmount) || 0;
        if (amount > 0) {
            user.availableSolBalance = (user.availableSolBalance || 0) + amount;
            user.totalSelfFarmingClaimed = (user.totalSelfFarmingClaimed || 0) + amount;
            user.minedSolBalance = 0;
            user.lastUpdated = Date.now();
            await user.save();
        }

        return res.json({
            success: true,
            user: {
                telegramId: user.telegramId,
                minedSolBalance: user.minedSolBalance || 0,
                availableSolBalance: user.availableSolBalance || 0,
                totalSelfFarmingClaimed: user.totalSelfFarmingClaimed || 0,
                selfFarmingBonus: user.totalSelfFarmingClaimed || 0,
                self_farming_bonus: user.totalSelfFarmingClaimed || 0,
                directReferralBonus: user.directReferralBonus || 0,
                direct_referral_bonus: user.directReferralBonus || 0,
                promoBonusBalance: user.promoBonusBalance || 0.0100
            }
        });
    } catch (err) {
        console.error('Claim Route Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/user/sync', async (req, res) => {
    try {
        const { 
            telegramId, 
            username, 
            firstName, 
            lastName,
            minedSolBalance, 
            availableSolBalance, 
            totalSelfFarmingClaimed, 
            activePlanTier, 
            userDepositAmount, 
            miningSpeedPerSec, 
            promoBonusBalance,
            profileName,
            profileMobile,
            profileEmail,
            profileSolAddress 
        } = req.body;

        if (!telegramId) {
            return res.status(400).json({ error: 'Telegram ID is required' });
        }

        const refCode = extractReferralCode(req.body);

        let user = await User.findOne({ telegramId });
        let isNewUser = false;
        let foundSponsorUser = null;

        if (!user) {
            isNewUser = true;
            const cleanU = username ? String(username).replace(/^@+/, '').trim() : '';
            const defaultProfileName = profileName || (cleanU ? `@${cleanU}` : (firstName || `User_${telegramId.slice(-4)}`));
            user = new User({ 
                telegramId, 
                username: cleanU, 
                firstName: firstName || '',
                profileName: defaultProfileName,
                activePlanTier: 'NONE',
                userDepositAmount: 0.00,
                miningSpeedPerSec: 0.0000,
                promoBonusBalance: 0.0100
            });

            if (refCode && refCode !== telegramId) {
                const sponsorUser = await findUserByIdentifier(refCode);
                if (sponsorUser && sponsorUser.telegramId !== telegramId) {
                    const cleanSpU = sponsorUser.username ? String(sponsorUser.username).replace(/^@+/, '').trim() : '';
                    user.sponsor = cleanSpU ? `@${cleanSpU}` : sponsorUser.telegramId;
                    foundSponsorUser = sponsorUser;
                }
            }
        } else {
            if (user.isBlocked) {
                return res.status(403).json({ success: false, error: 'User is blocked by admin' });
            }

            if (user.sponsor && user.sponsor !== 'None') {
                user.sponsor = cleanSponsorDisplay(user.sponsor);
            }

            if ((!user.sponsor || user.sponsor === 'None') && refCode && refCode !== telegramId) {
                const sponsorUser = await findUserByIdentifier(refCode);
                if (sponsorUser && sponsorUser.telegramId !== telegramId) {
                    const cleanSpU = sponsorUser.username ? String(sponsorUser.username).replace(/^@+/, '').trim() : '';
                    user.sponsor = cleanSpU ? `@${cleanSpU}` : sponsorUser.telegramId;
                    sponsorUser.promoBonusBalance = (sponsorUser.promoBonusBalance || 0.0100) + 0.01;
                    while (sponsorUser.promoBonusBalance >= 0.10) {
                        sponsorUser.promoBonusBalance -= 0.10;
                        sponsorUser.userDepositAmount = (sponsorUser.userDepositAmount || 0) + 0.10;
                    }
                    await recalculateUserLegs(sponsorUser);
                    await sponsorUser.save();
                    await recalculateSponsorByRef(user.sponsor);
                }
            }
        }

        if (isNewUser && foundSponsorUser) {
            foundSponsorUser.promoBonusBalance = (foundSponsorUser.promoBonusBalance || 0.0100) + 0.01;
            
            while (foundSponsorUser.promoBonusBalance >= 0.10) {
                foundSponsorUser.promoBonusBalance -= 0.10;
                foundSponsorUser.userDepositAmount = (foundSponsorUser.userDepositAmount || 0) + 0.10;
            }
            await recalculateUserLegs(foundSponsorUser);
            await foundSponsorUser.save();
        }

        if (username && typeof username === 'string' && username.trim() !== '' && username !== 'undefined') {
            user.username = username.replace(/^@+/, '').trim();
        }

        if (firstName && typeof firstName === 'string' && firstName.trim() !== '' && firstName !== 'undefined') {
            user.firstName = firstName;
        }

        if (profileName && typeof profileName === 'string' && profileName.trim() !== '') {
            user.profileName = profileName;
        } else if (!user.profileName) {
            user.profileName = user.username ? `@${user.username.replace(/^@+/, '')}` : (user.firstName || `User_${user.telegramId.slice(-4)}`);
        }

        if (profileMobile !== undefined) user.profileMobile = profileMobile;
        if (profileEmail !== undefined) user.profileEmail = profileEmail;
        if (profileSolAddress !== undefined) user.profileSolAddress = profileSolAddress;

        if (availableSolBalance !== undefined && availableSolBalance > (user.availableSolBalance || 0)) {
            user.availableSolBalance = availableSolBalance;
        }
        if (totalSelfFarmingClaimed !== undefined && totalSelfFarmingClaimed > (user.totalSelfFarmingClaimed || 0)) {
            user.totalSelfFarmingClaimed = totalSelfFarmingClaimed;
        }
        
        if (miningSpeedPerSec !== undefined && miningSpeedPerSec > 0) {
            user.miningSpeedPerSec = miningSpeedPerSec;
        }

        if (activePlanTier && activePlanTier !== 'NONE') {
            user.activePlanTier = activePlanTier;
        }

        if (userDepositAmount !== undefined) {
            user.userDepositAmount = Math.max(user.userDepositAmount || 0, userDepositAmount);
        }
        
        if (promoBonusBalance !== undefined && promoBonusBalance > (user.promoBonusBalance || 0.0100)) {
            user.promoBonusBalance = promoBonusBalance;
        }

        await recalculateUserLegs(user);

        while (user.promoBonusBalance >= 0.10) {
            user.promoBonusBalance -= 0.10;
            user.userDepositAmount = (user.userDepositAmount || 0) + 0.10;
        }

        if (user.userDepositAmount > 0) {
            let calculatedTier = 'STARTER';
            let calcSpeed = 0.00000578;
            if (user.userDepositAmount >= 25.10) {
                calculatedTier = 'GALAXY';
                calcSpeed = 0.00002315;
            } else if (user.userDepositAmount >= 10.10) {
                calculatedTier = 'PREMIUM';
                calcSpeed = 0.00001736;
            } else if (user.userDepositAmount >= 2.10) {
                calculatedTier = 'ADVANCE';
                calcSpeed = 0.00001157;
            } else {
                calculatedTier = 'STARTER';
                calcSpeed = 0.00000578;
            }
            user.activePlanTier = calculatedTier;
            user.miningSpeedPerSec = calcSpeed;
        }

        let offlineMined = 0;
        if (user.lastUpdated && user.activePlanTier && user.activePlanTier !== 'NONE') {
            const now = Date.now();
            const diffSeconds = (now - new Date(user.lastUpdated).getTime()) / 1000;
            let activeSpeed = user.miningSpeedPerSec > 0 ? user.miningSpeedPerSec : 0;

            if (diffSeconds > 0 && activeSpeed > 0) {
                offlineMined = diffSeconds * activeSpeed;
            }
        }

        if (minedSolBalance !== undefined) {
            if (minedSolBalance === 0) {
                user.minedSolBalance = offlineMined;
            } else {
                user.minedSolBalance = Math.max(user.minedSolBalance || 0, minedSolBalance) + offlineMined;
            }
        } else {
            user.minedSolBalance = (user.minedSolBalance || 0) + offlineMined;
        }

        if (user.sponsor && user.sponsor !== 'None') {
            await recalculateSponsorByRef(user.sponsor);
        }

        user.lastUpdated = Date.now();
        await user.save();

        const finalUsername = user.username || username || '';
        const formattedSponsor = cleanSponsorDisplay(user.sponsor);

        return res.json({ 
            success: true, 
            user: {
                telegramId: user.telegramId,
                username: finalUsername,
                firstName: user.firstName || firstName || '',
                profileName: user.profileName || finalUsername || user.firstName || `User_${user.telegramId.slice(-4)}`,
                profileMobile: user.profileMobile || '',
                profileEmail: user.profileEmail || '',
                profileSolAddress: user.profileSolAddress || '',
                sponsor: formattedSponsor,
                minedSolBalance: user.minedSolBalance || 0,
                availableSolBalance: user.availableSolBalance || 0,
                totalSelfFarmingClaimed: user.totalSelfFarmingClaimed || 0,
                selfFarmingBonus: user.totalSelfFarmingClaimed || 0,
                self_farming_bonus: user.totalSelfFarmingClaimed || 0,
                activePlanTier: user.activePlanTier || 'NONE',
                userDepositAmount: user.userDepositAmount || 0,
                miningSpeedPerSec: user.miningSpeedPerSec || 0,
                activeDirectsCount: user.activeDirectsCount || 0,
                promoBonusBalance: user.promoBonusBalance || 0.0100,
                directReferralBonus: user.directReferralBonus || 0,
                direct_referral_bonus: user.directReferralBonus || 0,
                teamReferralBonus: user.teamReferralBonus || 0,
                team_referral_bonus: user.teamReferralBonus || 0,
                teamOverrideBonus: user.teamOverrideBonus || 0,
                team_override_bonus: user.teamOverrideBonus || 0,
                rankRoyaltyBonus: user.rankRoyaltyBonus || 0,
                rank_royalty_bonus: user.rankRoyaltyBonus || 0,
                totalEarnedAmount: user.totalEarnedAmount || 0,
                strongestDone: user.userStrongestDone || 0,
                otherDone: user.userOtherDone || 0,
                userStrongestDone: user.userStrongestDone || 0,
                userOtherDone: user.userOtherDone || 0
            } 
        });

    } catch (error) {
        console.error('Sync Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.post('/api/user/team', async (req, res) => {
    try {
        const { telegramId, username, level } = req.body;
        if (!telegramId && !username) {
            return res.status(400).json({ success: false, error: 'Identifier required' });
        }

        const allUsers = await User.find(
            {},
            'telegramId username firstName profileName sponsor userDepositAmount lastUpdated activePlanTier'
        );

        const rootDoc = await findUserByIdentifier(telegramId || username);
        const rootIdentifiersSet = getUserIdentifiersSet(rootDoc);
        if (telegramId) rootIdentifiersSet.add(normalizeHandle(telegramId));
        if (username) rootIdentifiersSet.add(normalizeHandle(username));

        const levelsMap = getDownlineByLevels(allUsers, rootIdentifiersSet, 25);

        let totalTeamCount = 0;
        let totalTeamVolume = 0;
        const levelCounts = {};
        const levelVolumes = {};

        for (let lvl = 1; lvl <= 25; lvl++) {
            const arr = (levelsMap[lvl] || []).map(m => ({
                name: m.name,
                date: m.date,
                deposit: m.deposit,
                depositAmount: m.depositAmount,
                telegramId: m.telegramId,
                username: m.username,
                plan: m.plan,
                level: m.level
            }));
            levelsMap[lvl] = arr;
            levelCounts[lvl] = arr.length;
            const vol = arr.reduce((acc, m) => acc + (m.depositAmount || 0), 0);
            levelVolumes[lvl] = Number(vol.toFixed(2));
            totalTeamCount += arr.length;
            totalTeamVolume += vol;
        }

        const requestedLevel = parseInt(level, 10);
        const levelMembers = requestedLevel ? (levelsMap[requestedLevel] || []) : undefined;

        res.json({
            success: true,
            directs: levelsMap[1] || [],
            levels: levelsMap,
            levelCounts,
            levelVolumes,
            totalTeamCount,
            totalTeamVolume: Number(totalTeamVolume.toFixed(2)),
            ...(requestedLevel ? { level: requestedLevel, members: levelMembers } : {})
        });
    } catch (err) {
        console.error('Team Fetch Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/search', async (req, res) => {
    try {
        const { query } = req.body;
        if (!query) return res.status(400).json({ success: false, error: 'Query is required' });

        let cleanQuery = String(query).replace(/^@+/, '').trim();
        let user = await User.findOne({ 
            $or: [
                { username: { $regex: new RegExp('^' + escapeRegex(cleanQuery) + '$', 'i') } },
                { telegramId: cleanQuery }
            ]
        });

        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        let userRank = user.highestAchievedRank || 'NO RANK';
        if (userRank !== 'NO RANK') {
            let requiredStrongest = 12;
            let requiredOther = 18;
            
            if (user.userStrongestDone < requiredStrongest || user.userOtherDone < requiredOther) {
                userRank = 'NO RANK';
                user.highestAchievedRank = 'NO RANK';
                await user.save();
            }
        }

        // index.html adds '@' in front of data.user.sponsor, so send clean handle/ID without leading '@'
        res.json({
            success: true,
            user: {
                telegramId: user.telegramId,
                username: String(user.username || cleanQuery).replace(/^@+/, '').trim(),
                deposit: user.userDepositAmount || 0,
                sponsor: cleanSponsorRaw(user.sponsor),
                rank: userRank,
                status: user.isBlocked ? 'Blocked' : 'Active',
                availableSolBalance: user.availableSolBalance || 0,
                minedSolBalance: user.minedSolBalance || 0,
                strongestDone: user.userStrongestDone || 0,
                otherDone: user.userOtherDone || 0,
                userStrongestDone: user.userStrongestDone || 0,
                userOtherDone: user.userOtherDone || 0
            }
        });
    } catch (err) {
        console.error('Admin Search Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/balance', async (req, res) => {
    try {
        const { telegramId, username, amount, type } = req.body;
        let query = telegramId ? { telegramId } : { username: (username || '').replace(/^@+/, '').trim() };
        
        let user = await User.findOne(query);
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

        let val = parseFloat(amount) || 0;
        if (type === 'sub') {
            user.availableSolBalance = Math.max(0, (user.availableSolBalance || 0) - val);
        } else if (type === 'set') {
            user.availableSolBalance = val;
        } else {
            user.availableSolBalance = (user.availableSolBalance || 0) + val;
        }

        await user.save();
        res.json({ success: true, newBalance: user.availableSolBalance, message: 'Balance updated successfully' });
    } catch (err) {
        console.error('Admin Balance Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/topup', async (req, res) => {
    try {
        const { telegramId, username, amount } = req.body;
        let query = telegramId ? { telegramId } : { username: (username || '').replace(/^@+/, '').trim() };

        let user = await User.findOne(query);
        if (!user) return res.status(404).json({ success: false, error: 'User not found in database' });

        const topupAmount = parseFloat(amount) || 0.10;

        user.userDepositAmount = (user.userDepositAmount || 0) + topupAmount;

        let calculatedTier = 'STARTER';
        let calcSpeed = 0.00000578;
        if (user.userDepositAmount >= 25.10) {
            calculatedTier = 'GALAXY';
            calcSpeed = 0.00002315;
        } else if (user.userDepositAmount >= 10.10) {
            calculatedTier = 'PREMIUM';
            calcSpeed = 0.00001736;
        } else if (user.userDepositAmount >= 2.10) {
            calculatedTier = 'ADVANCE';
            calcSpeed = 0.00001157;
        } else {
            calculatedTier = 'STARTER';
            calcSpeed = 0.00000578;
        }

        user.activePlanTier = calculatedTier;
        user.miningSpeedPerSec = calcSpeed;

        await recalculateUserLegs(user);
        user.lastUpdated = Date.now();
        await user.save();

        if (user.sponsor && user.sponsor !== 'None') {
            await recalculateSponsorByRef(user.sponsor);
        }

        console.log(`Admin Top-Up Successful for User: ${user.telegramId || user.username}, Added: ${topupAmount} SOL, Total Deposit: ${user.userDepositAmount} SOL, Plan: ${calculatedTier}`);

        res.json({ 
            success: true, 
            message: `Successfully processed top-up of ${topupAmount.toFixed(2)} SOL! Total Deposit: ${user.userDepositAmount.toFixed(2)} SOL, Plan: ${calculatedTier}`,
            user: {
                telegramId: user.telegramId,
                username: user.username,
                deposit: user.userDepositAmount,
                plan: user.activePlanTier,
                promoBonusBalance: user.promoBonusBalance
            }
        });
    } catch (err) {
        console.error('Admin Top-Up Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/sponsor', async (req, res) => {
    try {
        const body = req.body || {};
        const candidateStr = [
            body.query,
            body.telegramId,
            body.userId,
            body.targetTelegramId,
            body.username,
            body.targetUsername,
            body.search,
            body.user
        ]
            .map(v => (v === undefined || v === null ? '' : String(v).replace(/^@+/, '').trim()))
            .find(Boolean);

        const user = await findUserByIdentifier(candidateStr);
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        const rawSponsor = body.sponsor ?? body.newSponsor ?? body.sponsorId ?? body.sponsorUsername ?? body.ref ?? '';
        const cleanSponsor = String(rawSponsor).replace(/^@+/, '').trim();

        const oldSponsor = user.sponsor;
        let nextSponsor = 'None';

        if (cleanSponsor && cleanSponsor.toLowerCase() !== 'none' && cleanSponsor.toLowerCase() !== 'null') {
            const sponsorDoc = await findUserByIdentifier(cleanSponsor);
            if (sponsorDoc) {
                const spCleanU = sponsorDoc.username ? String(sponsorDoc.username).replace(/^@+/, '').trim() : '';
                nextSponsor = spCleanU ? `@${spCleanU}` : sponsorDoc.telegramId;
            } else {
                nextSponsor = cleanSponsorDisplay(cleanSponsor);
            }
        }

        user.sponsor = nextSponsor;
        user.lastUpdated = Date.now();
        await user.save();

        if (oldSponsor && oldSponsor !== 'None') {
            await recalculateSponsorByRef(oldSponsor);
        }
        if (nextSponsor && nextSponsor !== 'None') {
            await recalculateSponsorByRef(nextSponsor);
        }

        res.json({ success: true, message: 'Sponsor updated successfully', sponsor: cleanSponsorRaw(user.sponsor) });
    } catch (err) {
        console.error('Admin Sponsor Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/block', async (req, res) => {
    try {
        const { telegramId, username } = req.body;
        let query = telegramId ? { telegramId } : { username: (username || '').replace(/^@+/, '').trim() };

        let user = await User.findOne(query);
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

        user.isBlocked = !user.isBlocked;
        await user.save();
        res.json({ success: true, status: user.isBlocked ? 'Blocked' : 'Active', message: 'User status updated' });
    } catch (err) {
        console.error('Admin Block Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/rank', async (req, res) => {
    try {
        const { telegramId, username, rank } = req.body;
        let query = telegramId ? { telegramId } : { username: (username || '').replace(/^@+/, '').trim() };

        let user = await User.findOne(query);
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

        user.highestAchievedRank = rank || 'NO RANK';
        await user.save();
        res.json({ success: true, message: 'Rank updated successfully' });
    } catch (err) {
        console.error('Admin Rank Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/fix-legs', async (req, res) => {
    try {
        const { telegramId, username, strongest, other } = req.body;
        let query = telegramId ? { telegramId } : { username: (username || '').replace(/^@+/, '').trim() };

        let user = await User.findOne(query);
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

        if (strongest !== undefined) user.userStrongestDone = parseFloat(strongest);
        if (other !== undefined) user.userOtherDone = parseFloat(other);

        await user.save();
        res.json({ 
            success: true, 
            message: 'Leg volumes updated successfully!', 
            strongest: user.userStrongestDone, 
            other: user.userOtherDone 
        });
    } catch (err) {
        console.error('Fix Legs Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/broadcast', upload.single('photo'), async (req, res) => {
    try {
        console.log('=== BROADCAST STARTED ===');
        const { message, photoUrl } = req.body;
        const photoFile = req.file;

        if (!message) {
            return res.status(400).json({ success: false, error: 'Broadcast message is required' });
        }

        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (!botToken) {
            console.error('Error: TELEGRAM_BOT_TOKEN is missing in environment variables!');
            return res.status(500).json({ success: false, error: 'Telegram Bot Token not configured on server' });
        }

        const users = await User.find({}, 'telegramId');
        console.log(`Total users found in database: ${users.length}`);

        if (!users || users.length === 0) {
            return res.json({ success: false, error: 'No users found in database to broadcast' });
        }

        let successCount = 0;
        let failCount = 0;

        for (const user of users) {
            try {
                let response;
                if (photoFile) {
                    const formData = new FormData();
                    formData.append('chat_id', user.telegramId);
                    formData.append('caption', message);
                    formData.append('parse_mode', 'HTML');
                    
                    const blob = new Blob([photoFile.buffer], { type: photoFile.mimetype });
                    formData.append('photo', blob, photoFile.originalname || 'broadcast.jpg');

                    response = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
                        method: 'POST',
                        body: formData
                    });
                } else if (photoUrl && photoUrl.trim() !== '') {
                    response = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: user.telegramId,
                            photo: photoUrl,
                            caption: message,
                            parse_mode: 'HTML'
                        })
                    });
                } else {
                    response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: user.telegramId,
                            text: message,
                            parse_mode: 'HTML'
                        })
                    });
                }

                const result = await response.json();
                if (result.ok) {
                    successCount++;
                } else {
                    console.error(`Failed for user ${user.telegramId}:`, result);
                    failCount++;
                }
            } catch (err) {
                console.error(`Exception for user ${user.telegramId}:`, err.message);
                failCount++;
            }
        }

        console.log(`=== BROADCAST FINISHED === Sent: ${successCount}, Failed: ${failCount}`);

        res.json({
            success: true,
            message: `Broadcast completed! Sent: ${successCount}, Failed: ${failCount}`
        });

    } catch (err) {
        console.error('Broadcast Route Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/admin/stats', async (req, res) => {
    try {
        let totalUsers = await User.countDocuments();
        if (totalUsers === 0) totalUsers = 1;
        
        const agg = await User.aggregate([
            { $group: { _id: null, totalDeposits: { $sum: "$userDepositAmount" } } }
        ]);
        const activeDeposits = agg.length > 0 ? agg[0].totalDeposits : 0;
        res.json({ success: true, totalUsers, activeDeposits });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/admin/users', async (req, res) => {
    try {
        let users = await User.find({}, 'telegramId username firstName profileName activePlanTier userDepositAmount')
                               .sort({ lastUpdated: -1 });
        
        if (!users || users.length === 0) {
            users = [{
                telegramId: '5939907983',
                username: 'Farming_Master',
                firstName: 'Admin',
                profileName: 'Admin',
                activePlanTier: 'NONE',
                userDepositAmount: 0.00
            }];
        }
        res.json({ success: true, users });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/withdraw', async (req, res) => {
    try {
        const { telegramId, amount, address } = req.body;

        if (!telegramId || !amount || !address) {
            return res.status(400).json({ success: false, error: 'Missing required withdrawal fields' });
        }

        const parsedAmount = parseFloat(amount);
        if (parsedAmount < 0.01) {
            return res.status(400).json({ success: false, error: 'Minimum withdrawal amount is 0.01 SOL' });
        }

        let user = await User.findOne({ telegramId });
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found in database' });
        }

        if (user.isBlocked) {
            return res.status(403).json({ success: false, error: 'User is blocked' });
        }

        if ((user.availableSolBalance || 0) < parsedAmount) {
            return res.status(400).json({ success: false, error: 'Insufficient available balance for withdrawal' });
        }

        const feeAmount = parsedAmount * 0.10;
        const netReceiveAmount = parsedAmount - feeAmount;

        user.availableSolBalance -= parsedAmount;
        user.totalEarnedAmount = (user.totalEarnedAmount || 0) + parsedAmount;
        await user.save();

        if (parsedAmount >= 0.01 && parsedAmount <= 0.10) {
            if (!adminKeypair) {
                user.availableSolBalance += parsedAmount;
                await user.save();
                return res.status(500).json({ success: false, error: 'Server wallet not configured for auto-payouts' });
            }

            try {
                const recipientPubKey = new PublicKey(address);
                const lamports = Math.floor(netReceiveAmount * 1000000000);

                const transaction = new Transaction().add(
                    SystemProgram.transfer({
                        fromPubkey: adminKeypair.publicKey,
                        toPubkey: recipientPubKey,
                        lamports: lamports,
                    })
                );

                const txId = await sendAndConfirmTransaction(
                    connection,
                    transaction,
                    [adminKeypair]
                );

                console.log(`Auto-Withdrawal Executed Successfully! TxID: ${txId}`);

                return res.json({
                    success: true,
                    status: 'Auto-Paid',
                    txId: txId,
                    requestedAmount: parsedAmount,
                    fee: feeAmount,
                    netAmount: netReceiveAmount,
                    newBalance: user.availableSolBalance,
                    message: 'Withdrawal processed successfully via blockchain.'
                });

            } catch (blockchainErr) {
                user.availableSolBalance += parsedAmount;
                await user.save();
                console.error('Blockchain Transfer Failed, Refunded User Balance:', blockchainErr.message);
                return res.status(500).json({ success: false, error: 'Blockchain transaction failed: ' + blockchainErr.message });
            }

        } else {
            return res.json({
                success: true,
                status: 'Pending Admin Approval',
                requestedAmount: parsedAmount,
                fee: feeAmount,
                netAmount: netReceiveAmount,
                newBalance: user.availableSolBalance,
                message: 'Withdrawal request sent for admin approval.'
            });
        }

    } catch (error) {
        console.error('Withdrawal Processing Error:', error);
        return res.status(500).json({ success: false, error: error.message || 'Blockchain transaction failed' });
    }
});

app.get('/', (req, res) => {
    res.send('SolMiningBot Server is Running Live!');
});

app.listen(PORT, () => {
    console.log('Server is running on port ' + PORT);
});
