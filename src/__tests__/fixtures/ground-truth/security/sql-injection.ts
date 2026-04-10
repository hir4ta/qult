// Ground truth: SQL injection patterns
// Expected: 2 detections (lines 4, 8)

const query1 = "SELECT * FROM users WHERE id = " + userId;

const name = req.query.name;
const query2 = `SELECT * FROM users WHERE name = ${name}`;

// Safe (parameterized) — should NOT be detected
const query3 = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
