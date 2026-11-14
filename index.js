const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } = require('@solana/web3.js');

const app = express();
app.use(express.json());
app.use(cors());
console.log('CORS is enabled for all origins');

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

let adminKeypair;
try {
    const secretKeyString = process.env.WALLET_PRIVATE_KEY;
    if (secretKeyString) {
        const secretKey = Uint8Array.from(JSON.parse(secretKeyString));
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

// Helper function to automatically calculate and update strongest and other leg volumes
async function recalculateUserLegs(user) {
    try {
        const identifier = user.username ? `@${user.username}` : user.telegramId;
        const alternativeId = user.username;

        // Find all direct referrals whose sponsor matches this user
        const directs = await User.find({
            $or: [
                { sponsor: identifier },
                { sponsor: user.telegramId },
                ...(alternativeId ? [{ sponsor: `@${alternativeId}` }] : [])
            ]
        });

        if (!directs || directs.length === 0) {
            user.userStrongestDone = 0.0;
            user.userOtherDone = 0.0;
            return;
        }

        // Calculate total deposit volume for each direct referral branch
        const directVolumes = directs.map(d => (d.userDepositAmount || 0));

        if (directVolumes.length === 0) {
            user.userStrongestDone = 0.0;
            user.userOtherDone = 0.0;
            return;
        }

        // Sort descending to find the strongest leg
        directVolumes.sort((a, b) => b - a);

        user.userStrongestDone = directVolumes[0]; // Highest single leg
        user.userOtherDone = directVolumes.slice(1).reduce((acc, val) => acc + val, 0.0); // Sum of all other legs
    } catch (err) {
        console.error('Error recalculating legs:', err);
    }
}

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
            promoBonusBalance 
        } = req.body;

        if (!telegramId) {
            return res.status(400).json({ error: 'Telegram ID is required' });
        }

        let user = await User.findOne({ telegramId });
        if (!user) {
            user = new User({ 
                telegramId, 
                username: username || '', 
                firstName: firstName || '',
                activePlanTier: 'NONE',
                userDepositAmount: 0.00,
                miningSpeedPerSec: miningSpeedPerSec || 0,
                promoBonusBalance: 0.0100
            });

            if (startParam) {
                const cleanSponsorQuery = startParam.replace('@', '').trim();
                let sponsorUser = await User.findOne({ 
                    $or: [
                        { telegramId: cleanSponsorQuery },
                        { username: { $regex: new RegExp('^' + cleanSponsorQuery + '$', 'i') } }
                    ]
                });
                if (sponsorUser) {
                    user.sponsor = sponsorUser.username ? `@${sponsorUser.username}` : sponsorUser.telegramId;
                }
            }
        } else {
            if (user.isBlocked) {
                return res.status(403).json({ success: false, error: 'User is blocked by admin' });
            }

            if ((!user.sponsor || user.sponsor === 'None') && startParam) {
                const cleanSponsorQuery = startParam.replace('@', '').trim();
                let sponsorUser = await User.findOne({ 
                    $or: [
                        { telegramId: cleanSponsorQuery },
                        { username: { $regex: new RegExp('^' + cleanSponsorQuery + '$', 'i') } }
                    ]
                });
                if (sponsorUser) {
                    user.sponsor = sponsorUser.username ? `@${sponsorUser.username}` : sponsorUser.telegramId;
                }
            }

            if (user.lastUpdated && user.activePlanTier && user.activePlanTier !== 'NONE') {
                const now = Date.now();
                const diffSeconds = (now - new Date(user.lastUpdated).getTime()) / 1000;
                let activeSpeed = user.miningSpeedPerSec > 0 ? user.miningSpeedPerSec : (miningSpeedPerSec || 0);

                if (diffSeconds > 0 && activeSpeed > 0) {
                    const offlineMined = diffSeconds * activeSpeed;
                    user.minedSolBalance = (user.minedSolBalance || 0) + offlineMined;
                }
            }
        }

        if (username && typeof username === 'string' && username.trim() !== '' && username !== 'undefined') {
            user.username = username;
        }

        if (firstName && typeof firstName === 'string' && firstName.trim() !== '' && firstName !== 'undefined') {
            user.firstName = firstName;
        }

        if (minedSolBalance !== undefined) {
            user.minedSolBalance = Math.max(user.minedSolBalance || 0, minedSolBalance);
        }
        if (availableSolBalance !== undefined) {
            user.availableSolBalance = Math.max(user.availableSolBalance || 0, availableSolBalance);
        }
        if (totalSelfFarmingClaimed !== undefined) {
            user.totalSelfFarmingClaimed = Math.max(user.totalSelfFarmingClaimed || 0, totalSelfFarmingClaimed);
        }
        
        if (miningSpeedPerSec !== undefined && miningSpeedPerSec > 0) {
            user.miningSpeedPerSec = miningSpeedPerSec;
        }

        if (activePlanTier && activePlanTier !== 'NONE') {
            user.activePlanTier = activePlanTier;
        }

        if (userDepositAmount !== undefined) user.userDepositAmount = Math.max(user.userDepositAmount || 0, userDepositAmount);
        if (promoBonusBalance !== undefined) user.promoBonusBalance = Math.max(user.promoBonusBalance || 0.0100, promoBonusBalance);

        if (user.promoBonusBalance >= 0.10 && (!user.activePlanTier || user.activePlanTier === 'NONE')) {
            user.activePlanTier = 'STARTER';
            user.userDepositAmount = 0.10;
        }

        // Automatically recalculate legs for this user
        await recalculateUserLegs(user);

        // Also update sponsor's legs if sponsor exists
        if (user.sponsor && user.sponsor !== 'None') {
            const sponsorClean = user.sponsor.replace('@', '').trim();
            let sponsorDoc = await User.findOne({
                $or: [{ telegramId: sponsorClean }, { username: { $regex: new RegExp('^' + sponsorClean + '$', 'i') } }]
            });
            if (sponsorDoc) {
                await recalculateUserLegs(sponsorDoc);
                await sponsorDoc.save();
            }
        }

        user.lastUpdated = Date.now();
        await user.save();

        const finalUsername = user.username || username || '';

        return res.json({ 
            success: true, 
            user: {
                telegramId: user.telegramId,
                username: finalUsername,
                firstName: user.firstName || firstName || '',
                sponsor: user.sponsor || 'None',
                minedSolBalance: user.minedSolBalance || 0,
                availableSolBalance: user.availableSolBalance || 0,
                totalSelfFarmingClaimed: user.totalSelfFarmingClaimed || 0,
                activePlanTier: user.activePlanTier || 'NONE',
                userDepositAmount: user.userDepositAmount || 0,
                miningSpeedPerSec: user.miningSpeedPerSec || 0,
                activeDirectsCount: user.activeDirectsCount || 0,
                promoBonusBalance: user.promoBonusBalance || 0.0100,
                totalEarnedAmount: user.totalEarnedAmount || 0,
                userStrongestDone: user.userStrongestDone || 0,
                userOtherDone: user.userOtherDone || 0
            } 
        });

    } catch (error) {
        console.error('Sync Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.post('/api/admin/search', async (req, res) => {
    try {
        const { query } = req.body;
        if (!query) return res.status(400).json({ success: false, error: 'Query is required' });

        let cleanQuery = query.replace('@', '').trim();
        let user = await User.findOne({ 
            $or: [
                { username: { $regex: new RegExp('^' + cleanQuery + '$', 'i') } },
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

        res.json({
            success: true,
            user: {
                telegramId: user.telegramId,
                username: user.username,
                deposit: user.userDepositAmount || 0,
                sponsor: user.sponsor || 'None',
                rank: userRank,
                status: user.isBlocked ? 'Blocked' : 'Active',
                availableSolBalance: user.availableSolBalance || 0,
                minedSolBalance: user.minedSolBalance || 0,
                strongestDone: user.userStrongestDone || 0,
                otherDone: user.userOtherDone || 0
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
        let query = telegramId ? { telegramId } : { username: (username || '').replace('@', '').trim() };
        
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

app.post('/api/admin/sponsor', async (req, res) => {
    try {
        const { telegramId, username, sponsor } = req.body;
        let query = telegramId ? { telegramId } : { username: (username || '').replace('@', '').trim() };

        let user = await User.findOne(query);
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

        user.sponsor = sponsor || 'None';
        await user.save();
        res.json({ success: true, message: 'Sponsor updated successfully' });
    } catch (err) {
        console.error('Admin Sponsor Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/block', async (req, res) => {
    try {
        const { telegramId, username } = req.body;
        let query = telegramId ? { telegramId } : { username: (username || '').replace('@', '').trim() };

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
        let query = telegramId ? { telegramId } : { username: (username || '').replace('@', '').trim() };

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
        let query = telegramId ? { telegramId } : { username: (username || '').replace('@', '').trim() };

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

        if (parsedAmount >= 0.01 && parsedAmount <= 0.10) {
            if (!adminKeypair) {
                return res.status(500).json({ success: false, error: 'Server wallet not configured for auto-payouts' });
            }

            user.availableSolBalance -= parsedAmount;
            user.totalEarnedAmount = (user.totalEarnedAmount || 0) + parsedAmount;
            await user.save();

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
                throw new Error('Blockchain transaction failed: ' + blockchainErr.message);
            }

        } else {
            user.availableSolBalance -= parsedAmount;
            await user.save();

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
