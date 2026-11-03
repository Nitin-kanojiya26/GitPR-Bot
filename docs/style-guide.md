# Engineering Team Style Guide & Standards

This document defines the core engineering and security standards enforced by the automated PR Review Bot.

---

## 1. Network Requests Must Have Timeouts and Error Handling

All external HTTP/network requests must include an explicit timeout (recommended: 5000ms or less) and must be wrapped in error handling (try/catch or catch handlers). Never make unhandled network calls.

### ❌ Bad Example:
```javascript
const response = await fetch("https://api.example.com/users").then(r => r.json());
```

### ✅ Good Example:
```javascript
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 5000);

try {
  const response = await fetch("https://api.example.com/users", { signal: controller.signal });
  if (!response.ok) throw new Error(`HTTP error ${response.status}`);
  const data = await response.json();
} catch (error) {
  logger.error("Failed to fetch users", error);
} finally {
  clearTimeout(timeout);
}
```

---

## 2. Safe Code Execution (Never Use eval)

Never use `eval()`, `new Function()`, or dynamic script evaluation with user-supplied inputs. This is a critical security vulnerability that enables Remote Code Execution (RCE) and code injection.

### ❌ Bad Example:
```javascript
function executeCalculation(userInput) {
  return eval(userInput);
}
```

### ✅ Good Example:
```javascript
function executeCalculation(userInput) {
  // Use a safe, dedicated mathematical expression parser
  return safeMathParser.evaluate(userInput);
}
```

---

## 3. No Hardcoded Secrets or Credentials

Never commit API keys, database passwords, JWT secrets, or private keys directly into code or repository files. Always read credentials from environment variables (`process.env`).

### ❌ Bad Example:
```javascript
const stripeClient = new Stripe("YOUR_STRIPE_SECRET_KEY_HERE");
```

### ✅ Good Example:
```javascript
const apiKey = process.env.STRIPE_API_KEY;
if (!apiKey) throw new Error("Missing STRIPE_API_KEY environment variable");
const stripeClient = new Stripe(apiKey);
```

---

## 4. Parameterized SQL Queries (No String Concatenation)

Never concatenate or interpolate user input directly into SQL queries. Always use parameterized queries or an ORM/query builder to prevent SQL injection vulnerabilities.

### ❌ Bad Example:
```javascript
const query = `SELECT * FROM users WHERE email = '${userEmail}'`;
const result = await db.query(query);
```

### ✅ Good Example:
```javascript
const query = "SELECT * FROM users WHERE email = $1";
const result = await db.query(query, [userEmail]);
```

---

## 5. Strict Input Validation on Public Functions and Endpoints

All external inputs entering the system via HTTP request bodies, query parameters, or public functions must be validated using a schema validator like Zod before being processed.

### ❌ Bad Example:
```javascript
app.post("/api/register", async (req, res) => {
  const { email, age } = req.body;
  await db.createUser(email, age);
});
```

### ✅ Good Example:
```javascript
const RegisterSchema = z.object({
  email: z.string().email(),
  age: z.number().int().min(18),
});

app.post("/api/register", async (req, res) => {
  const parsed = RegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.format() });
  }
  await db.createUser(parsed.data.email, parsed.data.age);
});
```

---

## 6. Use Structured Logging (No Raw console.log)

Production code must use a structured logger with appropriate log levels (debug, info, warn, error). Raw `console.log` statements pollute stdout and cannot be easily indexed by log aggregators.

### ❌ Bad Example:
```javascript
console.log("user logged in: " + user.id);
```

### ✅ Good Example:
```javascript
logger.info("User logged in successfully", { userId: user.id, timestamp: Date.now() });
```

---

## 7. Always Handle and Await Asynchronous Promises

Never fire-and-forget asynchronous promises without awaiting them or attaching a `.catch()` handler. Unhandled promises can cause silent failures or unhandled promise rejections that crash Node.js processes.

### ❌ Bad Example:
```javascript
function saveUserData(user) {
  db.save(user); // Missing await or catch!
}
```

### ✅ Good Example:
```javascript
async function saveUserData(user) {
  try {
    await db.save(user);
  } catch (error) {
    logger.error("Failed to save user data", { userId: user.id, error });
    throw error;
  }
}
```

---

## 8. Resource Cleanup and Closing Connections

Always clean up timers, open streams, file descriptors, and database connections in `finally` blocks or explicit teardown handlers to avoid memory leaks.

### ❌ Bad Example:
```javascript
async function readConfigFile(path) {
  const file = await fs.open(path, "r");
  return file.readFile("utf8"); // File handle is never closed!
}
```

### ✅ Good Example:
```javascript
async function readConfigFile(path) {
  const file = await fs.open(path, "r");
  try {
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}
```

---

## 9. Avoid Blocking the Node.js Event Loop

Do not perform heavy synchronous operations (like `fs.readFileSync`, heavy synchronous crypto, or large CPU loops) inside request handlers. Use asynchronous non-blocking alternatives or worker threads.

### ❌ Bad Example:
```javascript
app.get("/data", (req, res) => {
  const fileData = fs.readFileSync("./large-file.json"); // Blocks entire server!
  res.send(fileData);
});
```

### ✅ Good Example:
```javascript
app.get("/data", async (req, res) => {
  const fileData = await fs.promises.readFile("./large-file.json");
  res.send(fileData);
});
```

---

## 10. Descriptive Naming Conventions

Variable, function, and parameter names must clearly describe their intent. Avoid single-letter variables (except standard loop indices `i`, `j`), cryptic abbreviations, or misleading names.

### ❌ Bad Example:
```javascript
function chk(u, f) {
  const d = Date.now();
  return u.a > 18 && f;
}
```

### ✅ Good Example:
```javascript
function isUserEligible(user, hasActiveSubscription) {
  const isAdult = user.age >= 18;
  return isAdult && hasActiveSubscription;
}
```

