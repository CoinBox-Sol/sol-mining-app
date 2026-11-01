const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors'); // Agar CORS error aaye toh ye helpful rahega

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB Connected Successfully!'))
  .catch(err => console.error('MongoDB Connection Error:', err));

// --- NEW: User Schema & Model (Balance secure rakhne ke liye) ---
const userSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  username: { type: String },
  firstName: { type: String },
  minedBalance: { type: Number, default: 0.000146 },
  hashrate: { type: String, default: '2.0% / 24h' },
  lastUpdated: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// --- NEW: Sync API (App khulte hi database se data layega) ---
app.post('/api/user/sync', async (req, res) => {
  try {
    const { telegramId, username, firstName } = req.body;
    
    if (!telegramId) {
      return res.status(400).json({ error: 'Telegram ID is required' });
    }

    let user = await User.findOne({ telegramId });

    if (!user) {
      user = new User({
        telegramId,
        username,
        firstName,
        minedBalance: 0.000146
      });
      await user.save();
    }

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
