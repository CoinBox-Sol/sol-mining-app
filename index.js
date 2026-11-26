const express = require('express');
const path = require('path');
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
    lastMiningTickAt: { type: Number, default: Date.now },
    lastUpdated: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

function getDailyRateByPlan(planName) {
    if (planName === 'GALAXY') return 0.02;
    if (planName === 'PREMIUM') return 0.015;
    if (planName === 'ADVANCE') return 0.01;
    if (planName === 'STARTER') return 0.005;
    return 0.005;
}

function calculateMiningSpeedPerSec(planName, depositAmount) {
    const dep = Math.max(0, parseFloat(depositAmount) || 0);
    if (dep <= 0 || !planName || planName === 'NONE') return 0;
    return (dep * getDailyRateByPlan(planName)) / 86400;
}

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

function formatSponsorForUser(sponsorDoc) {
    if (!sponsorDoc) return 'None';
    const cleanU = sponsorDoc.username ? String(sponsorDoc.username).replace(/^@+/, '').trim() : '';
    return cleanU ? `@${cleanU}` : String(sponsorDoc.telegramId).trim();
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
        const idClean = normalizeHandle(u.telegramId);
        const unClean = normalizeHandle(u.username);
        if ((idClean && rootIdentifiersSet.has(idClean)) || (unClean && rootIdentifiersSet.has(unClean))) {
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
                const cIdNorm = normalizeHandle(candidate.telegramId);
                const cUnNorm = normalizeHandle(candidate.username);
                if (cIdNorm) nextSponsors.push(cIdNorm);
                if (cUnNorm) nextSponsors.push(cUnNorm);
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

        currentSponsors = Array.from(new Set(nextSponsors));
    }

    return levelsMap;
}

async function recalculateUserLegs(user) {
    try {
        const usernameClean = user.username ? user.username.replace(/^@+/, '').trim().toLowerCase() : '';
        const telegramIdStr = user.telegramId ? String(user.telegramId).trim() : '';

        const allUsers = await User.find({}, 'telegramId username sponsor userDepositAmount');
        const directs = allUsers.filter(u => {
            if (!u.telegramId || String(u.telegramId).trim() === telegramIdStr) return false;
            const spNorm = normalizeHandle(u.sponsor);
            if (!spNorm || spNorm === 'none') return false;
            return (telegramIdStr && spNorm === telegramIdStr) || (usernameClean && spNorm === usernameClean);
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
        directVolumes.sort((a, b) => b - a);

        user.userStrongestDone = directVolumes[0] || 0.0;
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

const OVERRIDE_LEVEL_CONFIG = {
    1:  { rate: 0.15, reqDirect: 0 },
    2:  { rate: 0.10, reqDirect: 2 },
    3:  { rate: 0.05, reqDirect: 3 },
    4:  { rate: 0.03, reqDirect: 4 },
    5:  { rate: 0.02, reqDirect: 5 },
    6:  { rate: 0.02, reqDirect: 6 },
    7:  { rate: 0.02, reqDirect: 7 },
    8:  { rate: 0.02, reqDirect: 8 },
    9:  { rate: 0.02, reqDirect: 9 },
    10: { rate: 0.02, reqDirect: 10 },
    11: { rate: 0.02, reqDirect: 11 },
    12: { rate: 0.02, reqDirect: 12 },
    13: { rate: 0.02, reqDirect: 13 },
    14: { rate: 0.02, reqDirect: 14 },
    15: { rate: 0.02, reqDirect: 15 },
    16: { rate: 0.02, reqDirect: 16 },
    17: { rate: 0.02, reqDirect: 17 },
    18: { rate: 0.02, reqDirect: 18 },
    19: { rate: 0.02, reqDirect: 19 },
    20: { rate: 0.02, reqDirect: 20 },
    21: { rate: 0.02, reqDirect: 21 },
    22: { rate: 0.03, reqDirect: 22 },
    23: { rate: 0.05, reqDirect: 23 },
    24: { rate: 0.10, reqDirect: 24 },
    25: { rate: 0.15, reqDirect: 25 }
};

function getUserDirectBusiness(uplineDoc) {
    const strongest = parseFloat(uplineDoc.userStrongestDone) || 0;
    const other = parseFloat(uplineDoc.userOtherDone) || 0;
    return strongest + other;
}

async function distributeTeamOverrideBonus(claimerUser, claimedAmount) {
    const amount = parseFloat(claimedAmount) || 0;
    if (!claimerUser || amount <= 0) return;

    let currentSponsorRef = cleanSponsorRaw(claimerUser.sponsor);
    const visited = new Set([normalizeHandle(claimerUser.telegramId), normalizeHandle(claimerUser.username)].filter(Boolean));

    for (let lvl = 1; lvl <= 25; lvl++) {
        if (!currentSponsorRef || currentSponsorRef === 'None') break;

        const uplineDoc = await findUserByIdentifier(currentSponsorRef);
        if (!uplineDoc) break;

        const uplineKeys = [normalizeHandle(uplineDoc.telegramId), normalizeHandle(uplineDoc.username)].filter(Boolean);
        if (uplineKeys.some(k => visited.has(k))) break;
        uplineKeys.forEach(k => visited.add(k));

        const cfg = OVERRIDE_LEVEL_CONFIG[lvl];
        const directBusiness = getUserDirectBusiness(uplineDoc);

        if (cfg && !uplineDoc.isBlocked && directBusiness >= cfg.reqDirect) {
            const overrideAmt = amount * cfg.rate;
            if (overrideAmt > 0) {
                uplineDoc.teamOverrideBonus = (parseFloat(uplineDoc.teamOverrideBonus) || 0) + overrideAmt;
                uplineDoc.availableSolBalance = (parseFloat(uplineDoc.availableSolBalance) || 0) + overrideAmt;
                uplineDoc.lastUpdated = new Date();
                await uplineDoc.save();
            }
        }

        currentSponsorRef = cleanSponsorRaw(uplineDoc.sponsor);
    }
}

function extractReferralCode(req) {
    const body = req.body || {};
    const query = req.query || {};
    const raw =
        body.startParam ||
        body.startapp ||
        body.ref ||
        body.referral ||
        body.sponsor ||
        body.start ||
        query.tgWebAppStartParam ||
        query.startapp ||
        query.start ||
        query.ref ||
        null;
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

        const tgIdStr = String(telegramId).trim();
        let user = await User.findOne({ telegramId: tgIdStr });
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        const nowMs = Date.now();
        const currentDeposit = Math.max(0, parseFloat(user.userDepositAmount) || 0);
        const speedPerSec = calculateMiningSpeedPerSec(user.activePlanTier, currentDeposit);
        const prevTickMs = Number(user.lastMiningTickAt) || (user.lastUpdated ? new Date(user.lastUpdated).getTime() : nowMs);
        const elapsedSec = Math.max(0, (nowMs - prevTickMs) / 1000);
        const accruedSinceLastTick = currentDeposit > 0 ? (speedPerSec * elapsedSec) : 0;

        const totalServerMined = Math.max(0, (parseFloat(user.minedSolBalance) || 0) + accruedSinceLastTick);
        const reqAmt = Math.max(0, parseFloat(claimedAmount) || 0);
        const finalClaim = totalServerMined > 0 ? totalServerMined : reqAmt;

        if (finalClaim > 0) {
            user.availableSolBalance = (user.availableSolBalance || 0) + finalClaim;
            user.totalSelfFarmingClaimed = (user.totalSelfFarmingClaimed || 0) + finalClaim;
            await distributeTeamOverrideBonus(user, finalClaim);
        }
        user.minedSolBalance = 0;
        user.miningSpeedPerSec = speedPerSec;
        user.lastMiningTickAt = nowMs;
        user.lastUpdated = new Date(nowMs);
        await user.save();

        return res.json({
            success: true,
            user: {
                telegramId: user.telegramId,
                minedSolBalance: 0,
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
            availableSolBalance, 
            totalSelfFarmingClaimed, 
            activePlanTier, 
            userDepositAmount, 
            promoBonusBalance,
            profileName,
            profileMobile,
            profileEmail,
            profileSolAddress
        } = req.body;

        if (!telegramId) {
            return res.status(400).json({ error: 'Telegram ID is required' });
        }

        const tgIdStr = String(telegramId).trim();
        const refCode = extractReferralCode(req);

        let user = await User.findOne({ telegramId: tgIdStr });
        let isNewUser = false;
        let sponsorAssignedNow = false;

        if (!user) {
            isNewUser = true;
            const cleanU = username ? String(username).replace(/^@+/, '').trim() : '';
            const defaultProfileName = profileName || (cleanU ? `@${cleanU}` : (firstName || `User_${tgIdStr.slice(-4)}`));
            user = new User({ 
                telegramId: tgIdStr, 
                username: cleanU, 
                firstName: firstName || '',
                profileName: defaultProfileName,
                sponsor: 'None',
                activePlanTier: 'NONE',
                userDepositAmount: 0.00,
                miningSpeedPerSec: 0.0000,
                promoBonusBalance: 0.0100,
                lastMiningTickAt: Date.now()
            });

            if (refCode && refCode !== tgIdStr) {
                const sponsorUser = await findUserByIdentifier(refCode);
                if (sponsorUser && String(sponsorUser.telegramId).trim() !== tgIdStr) {
                    user.sponsor = formatSponsorForUser(sponsorUser);
                    sponsorAssignedNow = true;
                }
            }
        } else {
            if (user.isBlocked) {
                return res.status(403).json({ success: false, error: 'User is blocked by admin' });
            }

            const currentSpClean = cleanSponsorRaw(user.sponsor);
            if (currentSpClean !== 'None') {
                user.sponsor = cleanSponsorDisplay(currentSpClean);
            } else if (refCode && refCode !== tgIdStr) {
                const sponsorUser = await findUserByIdentifier(refCode);
                if (sponsorUser && String(sponsorUser.telegramId).trim() !== tgIdStr) {
                    user.sponsor = formatSponsorForUser(sponsorUser);
                    sponsorAssignedNow = true;
                }
            }
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

        const isExplicitClaim = req.body.isClaim === true;

        if (!isExplicitClaim) {
            if (availableSolBalance !== undefined && availableSolBalance > (user.availableSolBalance || 0)) {
                user.availableSolBalance = availableSolBalance;
            }
            if (totalSelfFarmingClaimed !== undefined && totalSelfFarmingClaimed > (user.totalSelfFarmingClaimed || 0)) {
                user.totalSelfFarmingClaimed = totalSelfFarmingClaimed;
            }
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

        const nowMs = Date.now();
        const currentDeposit = Math.max(0, parseFloat(user.userDepositAmount) || 0);

        if (currentDeposit > 0) {
            if (currentDeposit >= 25.10) user.activePlanTier = 'GALAXY';
            else if (currentDeposit >= 10.10) user.activePlanTier = 'PREMIUM';
            else if (currentDeposit >= 2.10) user.activePlanTier = 'ADVANCE';
            else user.activePlanTier = 'STARTER';
        } else {
            user.activePlanTier = 'NONE';
        }

        const speedPerSec = calculateMiningSpeedPerSec(user.activePlanTier, currentDeposit);
        user.miningSpeedPerSec = speedPerSec;

        const prevTickMs = Number(user.lastMiningTickAt) || (user.lastUpdated ? new Date(user.lastUpdated).getTime() : nowMs);
        const elapsedSec = Math.max(0, (nowMs - prevTickMs) / 1000);
        const accruedSinceLastTick = currentDeposit > 0 ? (speedPerSec * elapsedSec) : 0;

        if (isExplicitClaim) {
            const totalToClaim = Math.max(0, (parseFloat(user.minedSolBalance) || 0) + accruedSinceLastTick);
            user.totalSelfFarmingClaimed = (parseFloat(user.totalSelfFarmingClaimed) || 0) + totalToClaim;
            user.availableSolBalance = (parseFloat(user.availableSolBalance) || 0) + totalToClaim;
            user.minedSolBalance = 0;
            user.lastMiningTickAt = nowMs;
            if (totalToClaim > 0) {
                await distributeTeamOverrideBonus(user, totalToClaim);
            }
        } else {
            const baseMined = Math.max(0, parseFloat(user.minedSolBalance) || 0);
            user.minedSolBalance = currentDeposit > 0 ? (baseMined + accruedSinceLastTick) : 0;
            user.lastMiningTickAt = nowMs;
        }

        user.lastUpdated = new Date(nowMs);
        await user.save();

        if (sponsorAssignedNow && user.sponsor && user.sponsor !== 'None') {
            const sponsorDoc = await findUserByIdentifier(user.sponsor);
            if (sponsorDoc) {
                sponsorDoc.promoBonusBalance = (sponsorDoc.promoBonusBalance || 0.0100) + 0.01;
                while (sponsorDoc.promoBonusBalance >= 0.10) {
                    sponsorDoc.promoBonusBalance -= 0.10;
                    sponsorDoc.userDepositAmount = (sponsorDoc.userDepositAmount || 0) + 0.10;
                }
                await recalculateUserLegs(sponsorDoc);
                sponsorDoc.lastUpdated = new Date();
                await sponsorDoc.save();
            }
        } else if (user.sponsor && user.sponsor !== 'None') {
            await recalculateSponsorByRef(user.sponsor);
        }

        const finalUsername = user.username || username || '';
        const formattedSponsor = cleanSponsorDisplay(user.sponsor);

        return res.json({ 
            success: true,
            isNewUser,
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

        const cleanUsername = String(user.username || '').replace(/^@+/, '').trim();

        res.json({
            success: true,
            user: {
                telegramId: user.telegramId,
                username: cleanUsername || user.telegramId,
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
        let query = telegramId ? { telegramId: String(telegramId).trim() } : { username: (username || '').replace(/^@+/, '').trim() };
        
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
        let query = telegramId ? { telegramId: String(telegramId).trim() } : { username: (username || '').replace(/^@+/, '').trim() };

        let user = await User.findOne(query);
        if (!user) return res.status(404).json({ success: false, error: 'User not found in database' });

        const topupAmount = parseFloat(amount) || 0.10;
        const nowMs = Date.now();
        const prevDeposit = Math.max(0, parseFloat(user.userDepositAmount) || 0);
        const prevSpeed = calculateMiningSpeedPerSec(user.activePlanTier, prevDeposit);
        const prevTickMs = Number(user.lastMiningTickAt) || (user.lastUpdated ? new Date(user.lastUpdated).getTime() : nowMs);
        const elapsedSec = Math.max(0, (nowMs - prevTickMs) / 1000);
        if (prevDeposit > 0 && prevSpeed > 0) {
            user.minedSolBalance = Math.max(0, parseFloat(user.minedSolBalance) || 0) + (prevSpeed * elapsedSec);
        }

        user.userDepositAmount = prevDeposit + topupAmount;

        let calculatedTier = 'STARTER';
        if (user.userDepositAmount >= 25.10) {
            calculatedTier = 'GALAXY';
        } else if (user.userDepositAmount >= 10.10) {
            calculatedTier = 'PREMIUM';
        } else if (user.userDepositAmount >= 2.10) {
            calculatedTier = 'ADVANCE';
        } else {
            calculatedTier = 'STARTER';
        }

        user.activePlanTier = calculatedTier;
        user.miningSpeedPerSec = calculateMiningSpeedPerSec(calculatedTier, user.userDepositAmount);
        user.lastMiningTickAt = nowMs;

        await recalculateUserLegs(user);
        user.lastUpdated = new Date(nowMs);
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
                nextSponsor = formatSponsorForUser(sponsorDoc);
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
        let query = telegramId ? { telegramId: String(telegramId).trim() } : { username: (username || '').replace(/^@+/, '').trim() };

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
        let query = telegramId ? { telegramId: String(telegramId).trim() } : { username: (username || '').replace(/^@+/, '').trim() };

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
        let query = telegramId ? { telegramId: String(telegramId).trim() } : { username: (username || '').replace(/^@+/, '').trim() };

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

        const tgIdStr = String(telegramId).trim();
        let user = await User.findOne({ telegramId: tgIdStr });
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
    res.sendFile(path.join(__dirname, 'index.html'));
});

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://sol-mining-farm-bot-jrni.onrender.com';

async function tgApi(method, payload) {
    if (!BOT_TOKEN) return null;
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    return await res.json();
}

async function handleBotStart(msg) {
    if (!msg || !msg.text || !msg.from) return;
    const text = String(msg.text).trim();
    if (!text.startsWith('/start')) return;

    const parts = text.split(/\s+/);
    const rawPayload = parts[1] ? String(parts[1]).trim() : '';
    const refCode = rawPayload
        ? rawPayload.replace(/^(ref_|start_|sponsor_)/i, '').trim()
        : '';

    const tgIdStr = String(msg.from.id).trim();
    const cleanU = msg.from.username ? String(msg.from.username).replace(/^@+/, '').trim() : '';
    const firstName = msg.from.first_name || '';

    let user = await User.findOne({ telegramId: tgIdStr });
    let isNewUser = false;
    let sponsorAssignedNow = false;

    if (!user) {
        isNewUser = true;
        user = new User({
            telegramId: tgIdStr,
            username: cleanU,
            firstName,
            profileName: cleanU ? `@${cleanU}` : (firstName || `User_${tgIdStr.slice(-4)}`),
            sponsor: 'None'
        });
    } else if (user.isBlocked) {
        await tgApi('sendMessage', {
            chat_id: msg.chat.id,
            text: '🚫 Your account is blocked by admin.'
        });
        return;
    }

    if (cleanU) user.username = cleanU;
    if (firstName) user.firstName = firstName;

    const currentSpClean = cleanSponsorRaw(user.sponsor);
    if (currentSpClean !== 'None') {
        user.sponsor = cleanSponsorDisplay(currentSpClean);
    } else if (refCode && refCode.toLowerCase() !== 'none' && refCode !== tgIdStr) {
        const sponsorUser = await findUserByIdentifier(refCode);
        if (sponsorUser && String(sponsorUser.telegramId).trim() !== tgIdStr) {
            user.sponsor = formatSponsorForUser(sponsorUser);
            sponsorAssignedNow = true;
        }
    }

    user.lastUpdated = Date.now();
    await user.save();

    if (isNewUser || sponsorAssignedNow) {
        const spDoc = await findUserByIdentifier(user.sponsor);
        if (spDoc) {
            if (sponsorAssignedNow) {
                spDoc.promoBonusBalance = (spDoc.promoBonusBalance || 0.0100) + 0.01;
                while (spDoc.promoBonusBalance >= 0.10) {
                    spDoc.promoBonusBalance -= 0.10;
                    spDoc.userDepositAmount = (spDoc.userDepositAmount || 0) + 0.10;
                }
            }
            await recalculateUserLegs(spDoc);
            spDoc.lastUpdated = Date.now();
            await spDoc.save();
        }
    }

    const savedSponsor = cleanSponsorDisplay(user.sponsor);
    const appLaunchUrl = savedSponsor !== 'None'
        ? `${MINI_APP_URL}?startapp=${encodeURIComponent(cleanSponsorRaw(user.sponsor))}`
        : MINI_APP_URL;

    await tgApi('sendMessage', {
        chat_id: msg.chat.id,
        text:
            `⚡ <b>SolMiningFarmBot</b>\n\n` +
            `• Status: <b>Active ID</b>\n` +
            `• Sponsor: <b>${savedSponsor}</b>\n\n` +
            `Open Mini App below to start mining:`,
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [[
                { text: '🚀 Open SolMiningFarm Mini App', web_app: { url: appLaunchUrl } }
            ]]
        }
    });
}

let botUpdateOffset = 0;
let botPollingActive = false;

async function pollBotUpdates() {
    if (!BOT_TOKEN || botPollingActive) return;
    botPollingActive = true;
    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook`);
    } catch (_) {}
    while (true) {
        try {
            const res = await fetch(
                `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${botUpdateOffset}&timeout=25&allowed_updates=${encodeURIComponent(JSON.stringify(['message']))}`
            );
            const data = await res.json();
            if (data && data.ok && Array.isArray(data.result)) {
                for (const upd of data.result) {
                    botUpdateOffset = upd.update_id + 1;
                    if (upd.message) {
                        await handleBotStart(upd.message);
                    }
                }
            }
        } catch (err) {
            await new Promise(r => setTimeout(r, 3000));
        }
    }
}

if (BOT_TOKEN) {
    pollBotUpdates();
    console.log('Telegram /start Sponsor Listener Active');
} else {
    console.warn('TELEGRAM_BOT_TOKEN not set; bot /start listener not started');
}

app.listen(PORT, () => {
    console.log('Server is running on port ' + PORT);
});
