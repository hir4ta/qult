// Ground truth: Hardcoded secrets
// Expected: 2 detections (lines 4, 7)
// Note: Stripe key excluded to avoid GitHub Push Protection triggering on test fixtures

const awsKey = "AKIAIOSFODNN7EXAMPLE";

const githubToken = "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

const apiKey = process.env.STRIPE_KEY;

// Safe — should NOT be detected
const envKey = process.env.API_KEY;
const configKey = os.environ.get("SECRET");
