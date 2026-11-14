const { Keypair } = require('@solana/web3.js');
const base58 = require('bs58');
const base58Key = "3C5nAyexeVUyf7xip7eWC17HdsZrAN8noVMJB4XhdvqTK2brncAHTExkPtRqaDv3qtkRf1K9iT2UKEgA95PskgPq";
try {
    const decoded = Keypair.fromSecretKey(base58.decode(base58Key));
    console.log("ARRAY_KEY_START>>" + JSON.stringify(Array.from(decoded.secretKey)) + "<<ARRAY_KEY_END");
} catch (e) {
    console.error("Error decoding:", e.message);
}
