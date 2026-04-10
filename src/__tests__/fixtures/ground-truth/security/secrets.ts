// Ground truth: Hardcoded secrets
// Expected: 3 detections (lines 4, 7, 10)

const awsKey = "AKIAIOSFODNN7EXAMPLE";

const githubToken = "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

const apiKey: string = "sk_live_abcdefghijklmnopqrstuvwxyz";

// Safe — should NOT be detected
const envKey = process.env.API_KEY;
const configKey = os.environ.get("SECRET");
