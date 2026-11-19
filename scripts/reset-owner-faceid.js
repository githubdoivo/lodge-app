// Lost phone, owner edition (APP-LG-001): clears the owner's Face ID and signs
// them out everywhere. Run on the server, then sign in with
// the owner key (npm run admin-token) and add Face ID again on the new phone.
import 'dotenv/config';
import db from '../src/db.js';

const owner = db.prepare('SELECT id, name FROM users WHERE is_owner = 1').get();
if (!owner) {
  console.log('No owner yet.');
} else {
  const n = db.prepare('DELETE FROM passkeys WHERE user_id = ?').run(owner.id).changes;
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(owner.id);
  console.log(`Cleared ${n} Face ID passkey(s) for ${owner.name}. Sign in with the owner key to add a new one.`);
}
