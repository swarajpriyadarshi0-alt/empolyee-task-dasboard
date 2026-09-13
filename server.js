const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const INDEX_FILE = path.join(process.cwd(), "index.html");
const SHEET_RANGE = "A1";

const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL =
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;

function getPrivateKey() {
  let key = process.env.GOOGLE_PRIVATE_KEY || "";

  // Convert escaped new lines into actual new lines
  key = key.replace(/\\n/g, "\n");

  // Remove accidental surrounding quotes
  key = key.replace(/^['"]|['"]$/g, "");

  // Remove accidental spaces before/after the key
  key = key.trim();

  // Convert escaped quotation marks if present
  key = key.replace(/\\"/g, '"');
cç.      
  return key;
}

const GOOGLE_PRIVATE_KEY = getPrivateKey();

const sessions = new Map();

const EMPLOYEE_NAMES = [
  "Swaraj Priyadarshi",
  "Utkarsh",
  "Aditi Sahu",
  "Sristi",
  "Geeteka",
  "Prerna",
  "Siddhi",
  "Prem",
  "Riya",
  "Chintu",
  "Nashrah",
  "Neha",
  "Kanhaiya",
  "Deepali"
];

const BRANCH_NAMES = [
  "Sec 14",
  "Noida 16",
  "Asaf Ali",
  "DLF CP",
  "Ballabgarh"
];

const STATUSES = [
  "Not Started",
  "In Progress",
  "Completed",
  "On Hold",
  "Pending Review"
];

const PRIORITIES = [
  "Low",
  "Medium",
  "High",
  "Urgent"
];

const now = () => new Date().toISOString();

const uid = prefix =>
  `${prefix}_${crypto.randomBytes(5).toString("hex")}`;

const hash = (password, salt) =>
  `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;

const passwordHash = (
  password,
  salt = crypto.randomBytes(16).toString("hex")
) => hash(password, salt);

function verify(password, stored) {
  const [salt, key] = String(stored || "").split(":");

  if (!salt || !key) return false;

  try {
    const derived = crypto.scryptSync(password, salt, 64);
    const storedBuffer = Buffer.from(key, "hex");

    return (
      storedBuffer.length === derived.length &&
      crypto.timingSafeEqual(storedBuffer, derived)
    );
  } catch {
    return false;
  }
}

function send(res, status, payload, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers
  });

  res.end(JSON.stringify(payload));
}

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .filter(Boolean)
      .map(value => {
        const [key, ...rest] = value.trim().split("=");

        return [
          key,
          decodeURIComponent(rest.join("="))
        ];
      })
  );
}

function requestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", chunk => {
      raw += chunk;

      if (raw.length > 2_000_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid request body."));
      }
    });

    req.on("error", reject);
  });
}

function findUser(db, id) {
  return db.users.find(item => item.id === id);
}

function findBranch(db, id) {
  return db.branches.find(item => item.id === id);
}

function activeBranchIds(db, ids) {
  return [
    ...new Set(
      (Array.isArray(ids) ? ids : [])
        .filter(id => findBranch(db, id)?.active)
    )
  ];
}

function notify(db, userId, type, title, body) {
  db.notifications.unshift({
    id: uid("note"),
    userId,
    type,
    title,
    body,
    read: false,
    createdAt: now()
  });
}

function log(
  db,
  taskId,
  changedBy,
  action,
  previousValue,
  newValue
) {
  db.taskHistory.unshift({
    id: uid("history"),
    taskId,
    changedBy,
    action,
    previousValue,
    newValue,
    timestamp: now()
  });
}

function safeUser(user) {
  if (!user) return null;

  const {
    passwordHash: ignored,
    ...publicUser
  } = user;

  return publicUser;
}

function userView(user, db) {
  return {
    ...safeUser(user),

    branches: (user.branchIds || [])
      .map(id => findBranch(db, id))
      .filter(Boolean)
      .map(branch => ({
        id: branch.id,
        name: branch.name,
        active: branch.active
      }))
  };
}

function taskView(task, db) {
  if (!task) return null;

  const group = task.assignmentGroupId
    ? db.tasks.filter(
        item =>
          item.assignmentGroupId === task.assignmentGroupId
      )
    : [task];

  const employee = findUser(db, task.employeeId);

  return {
    ...task,

    assigneeId: task.employeeId,

    assigneeName:
      employee?.name || "Unassigned",

    branchName:
      findBranch(db, task.branchId)?.name || "Unassigned",

    assignedEmployees: group.map(item => {
      const assignedEmployee =
        findUser(db, item.employeeId);

      return {
        id: item.employeeId,
        name: assignedEmployee?.name || "Unassigned",
        userId: assignedEmployee?.userId || "",
        taskId: item.id,
        status: item.status,
        progress: item.progress
      };
    })
  };
}

function validProgress(value) {
  return (
    Number.isInteger(Number(value)) &&
    Number(value) >= 0 &&
    Number(value) <= 100
  );
}

function branchView(db, branch) {
  const tasks = db.tasks.filter(
    task => task.branchId === branch.id
  );

  return {
    ...branch,

    totalTasks: tasks.length,

    completed: tasks.filter(
      task => task.status === "Completed"
    ).length,

    inProgress: tasks.filter(
      task => task.status === "In Progress"
    ).length,

    pending: tasks.filter(task =>
      [
        "Not Started",
        "Pending Review",
        "On Hold"
      ].includes(task.status)
    ).length,

    overdue: tasks.filter(
      task =>
        task.status !== "Completed" &&
        task.dueDate < now().slice(0, 10)
    ).length,

    progress: tasks.length
      ? Math.round(
          tasks.reduce(
            (sum, task) => sum + Number(task.progress || 0),
            0
          ) / tasks.length
        )
      : 0
  };
}

function performanceView(
  db,
  visibleTasks = db.tasks,
  employeeId = null
) {
  const employees = db.users.filter(
    user =>
      user.role === "employee" &&
      (!employeeId || user.id === employeeId)
  );

  const employeeRows = employees.map(employee => {
    const tasks = visibleTasks.filter(
      task => task.employeeId === employee.id
    );

    const completed = tasks.filter(
      task => task.status === "Completed"
    ).length;

    return {
      employeeId: employee.id,
      employeeName: employee.name,
      completed,

      pending: tasks.filter(task =>
        [
          "Not Started",
          "Pending Review",
          "On Hold"
        ].includes(task.status)
      ).length,

      inProgress: tasks.filter(
        task => task.status === "In Progress"
      ).length,

      overdue: tasks.filter(
        task =>
          task.status !== "Completed" &&
          task.dueDate < now().slice(0, 10)
      ).length,

      total: tasks.length,

      completionRate: tasks.length
        ? Math.round((completed / tasks.length) * 100)
        : 0,

      progress: tasks.length
        ? Math.round(
            tasks.reduce(
              (sum, task) => sum + Number(task.progress || 0),
              0
            ) / tasks.length
          )
        : 0
    };
  });

  const completed = visibleTasks.filter(
    task => task.status === "Completed"
  ).length;

  return {
    employees: employeeRows,

    summary: {
      totalTasks: visibleTasks.length,
      completed,

      pending: visibleTasks.filter(task =>
        [
          "Not Started",
          "Pending Review",
          "On Hold"
        ].includes(task.status)
      ).length,

      inProgress: visibleTasks.filter(
        task => task.status === "In Progress"
      ).length,

      overdue: visibleTasks.filter(
        task =>
          task.status !== "Completed" &&
          task.dueDate < now().slice(0, 10)
      ).length,

      completionRate: visibleTasks.length
        ? Math.round((completed / visibleTasks.length) * 100)
        : 0,

      progress: visibleTasks.length
        ? Math.round(
            visibleTasks.reduce(
              (sum, task) => sum + Number(task.progress || 0),
              0
            ) / visibleTasks.length
          )
        : 0
    }
  };
}

/* =========================================================
   GOOGLE SHEETS DATABASE
   ========================================================= */

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function createGoogleJWT() {
  if (
    !GOOGLE_SERVICE_ACCOUNT_EMAIL ||
    !GOOGLE_PRIVATE_KEY
  ) {
    throw new Error(
      "Google service account environment variables are missing."
    );
  }

  if (
    !GOOGLE_PRIVATE_KEY.includes("BEGIN PRIVATE KEY") ||
    !GOOGLE_PRIVATE_KEY.includes("END PRIVATE KEY")
  ) {
    throw new Error(
      "GOOGLE_PRIVATE_KEY is not formatted correctly."
    );
  }

  const header = base64Url(
    JSON.stringify({
      alg: "RS256",
      typ: "JWT"
    })
  );

  const issuedAt = Math.floor(Date.now() / 1000);

  const claim = base64Url(
    JSON.stringify({
      iss: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      exp: issuedAt + 3600,
      iat: issuedAt
    })
  );

  const unsigned = `${header}.${claim}`;

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();

  const signature = signer
    .sign(GOOGLE_PRIVATE_KEY, "base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${unsigned}.${signature}`;
}

async function getGoogleAccessToken() {
  const jwt = createGoogleJWT();

  const response = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
      },

      body:
        `grant_type=${encodeURIComponent(
          "urn:ietf:params:oauth:grant-type:jwt-bearer"
        )}` +
        `&assertion=${encodeURIComponent(jwt)}`
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Google authentication failed: ${
        data.error_description ||
        data.error ||
        "Unknown error"
      }`
    );
  }

  return data.access_token;
}

async function readGoogleDatabase() {
  if (!GOOGLE_SHEET_ID) {
    throw new Error(
      "GOOGLE_SHEET_ID environment variable is missing."
    );
  }

  const token = await getGoogleAccessToken();

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/` +
    `${encodeURIComponent(GOOGLE_SHEET_ID)}` +
    `/values/${encodeURIComponent(SHEET_RANGE)}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Google Sheets read failed: ${
        data.error?.message || "Unknown error"
      }`
    );
  }

  const value = data.values?.[0]?.[0];

  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch {
    throw new Error(
      "The data stored in Google Sheet A1 is not valid JSON."
    );
  }
}

async function writeGoogleDatabase(db) {
  if (!GOOGLE_SHEET_ID) {
    throw new Error(
      "GOOGLE_SHEET_ID environment variable is missing."
    );
  }

  const token = await getGoogleAccessToken();

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/` +
    `${encodeURIComponent(GOOGLE_SHEET_ID)}` +
    `/values/${encodeURIComponent(SHEET_RANGE)}` +
    `?valueInputOption=RAW`;

  const response = await fetch(url, {
    method: "PUT",

    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },

    body: JSON.stringify({
      range: SHEET_RANGE,
      majorDimension: "ROWS",
      values: [[JSON.stringify(db)]]
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Google Sheets write failed: ${
        data.error?.message || "Unknown error"
      }`
    );
  }

  return true;
}

/* =========================================================
   INITIAL DATABASE
   ========================================================= */

function seed() {
  const createdAt = now();

  const users = [
    {
      id: "usr_admin",
      name: "Ankit Maheswari",
      userId: "admin",
      role: "admin",
      passwordHash: hash("admin123", "admin-demo-salt"),
      active: true,
      branchIds: [],
      createdAt,
      updatedAt: createdAt
    },

    {
      id: "usr_matrix_admin",
      name: "Matrix IT Support",
      userId: "matrix",
      role: "admin",
      passwordHash: hash("matrix1234", "matrix-demo-salt"),
      active: true,
      branchIds: [],
      createdAt,
      updatedAt: createdAt
    }
  ];

  EMPLOYEE_NAMES.forEach((name, index) => {
    const words = name.split(" ");

    const code = (
      words.length > 1
        ? words.map(word => word[0]).join("")
        : name.slice(0, 2)
    )
      .slice(0, 2)
      .toUpperCase();

    users.push({
      id: `usr_emp_${String(index + 1).padStart(3, "0")}`,
      name,

      userId: `${code}${String(index + 1).padStart(3, "0")}`,

      role: "employee",

      passwordHash: hash(
        "employee123",
        `employee-${index + 1}`
      ),

      active: true,
      branchIds: [],
      createdAt,
      updatedAt: createdAt
    });
  });

  return {
    users,

    branches: BRANCH_NAMES.map(name => ({
      id: uid("branch"),
      name,
      active: true,
      createdAt,
      updatedAt: createdAt
    })),

    tasks: [],
    taskHistory: [],
    notifications: []
  };
}

async function getDatabase() {
  let db = await readGoogleDatabase();

  if (!db) {
    const oldFile = path.join(process.cwd(), "data.json");

    if (fs.existsSync(oldFile)) {
      try {
        db = JSON.parse(fs.readFileSync(oldFile, "utf8"));
      } catch {
        db = seed();
      }
    } else {
      db = seed();
    }

    db.users ||= [];
    db.branches ||= [];
    db.tasks ||= [];
    db.taskHistory ||= [];
    db.notifications ||= [];

    await writeGoogleDatabase(db);
  }

  let changed = false;

  if (!Array.isArray(db.users)) {
    db.users = [];
    changed = true;
  }

  if (!Array.isArray(db.branches)) {
    db.branches = [];
    changed = true;
  }

  if (!Array.isArray(db.tasks)) {
    db.tasks = [];
    changed = true;
  }

  if (!Array.isArray(db.taskHistory)) {
    db.taskHistory = [];
    changed = true;
  }

  if (!Array.isArray(db.notifications)) {
    db.notifications = [];
    changed = true;
  }

  if (
    !db.users.some(
      user =>
        String(user.userId).toLowerCase() === "matrix"
    )
  ) {
    const createdAt = now();

    db.users.push({
      id: "usr_matrix_admin",
      name: "Matrix IT Support",
      userId: "matrix",
      role: "admin",
      passwordHash: hash("matrix1234", "matrix-demo-salt"),
      active: true,
      branchIds: [],
      createdAt,
      updatedAt: createdAt
    });

    changed = true;
  }

  if (changed) {
    await writeGoogleDatabase(db);
  }

  return db;
}

/* =========================================================
   SESSION
   ========================================================= */

function currentUser(req) {
  const cookies = parseCookies(req);

  return sessions.get(cookies.session);
}

function requireUser(req, res, role) {
  const user = currentUser(req);

  if (!user) {
    send(res, 401, {
      error: "Please sign in."
    });

    return null;
  }

  if (role && user.role !== role) {
    send(res, 403, {
      error: "Manager access required."
    });

    return null;
  }

  return user;
}

/* =========================================================
   API
   ========================================================= */

async function api(req, res, url) {
  const db = await getDatabase();

  if (
    req.method === "POST" &&
    url === "/api/login"
  ) {
    const input = await requestBody(req);

    const user = db.users.find(
      item =>
        String(item.userId).toLowerCase() ===
        String(input.userId || "").trim().toLowerCase()
    );

    if (
      !user ||
      !user.active ||
      !verify(String(input.password || ""), user.passwordHash)
    ) {
      return send(res, 401, {
        error: "Invalid credentials or inactive account."
      });
    }

    const token = crypto.randomBytes(32).toString("hex");

    sessions.set(token, {
      id: user.id,
      role: user.role
    });

    return send(
      res,
      200,
      {
        user: userView(user, db)
      },
      {
        "Set-Cookie":
          `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`
      }
    );
  }

  if (
    req.method === "POST" &&
    url === "/api/logout"
  ) {
    const cookies = parseCookies(req);

    sessions.delete(cookies.session);

    return send(
      res,
      200,
      { ok: true },
      {
        "Set-Cookie":
          "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
      }
    );
  }

  const actor = requireUser(req, res);

  if (!actor) return;

  if (
    actor.role !== "admin" &&
    (
      url.startsWith("/api/users") ||
      url.startsWith("/api/branches") ||
      (url === "/api/tasks" && req.method === "POST") ||
      url === "/api/history"
    )
  ) {
    return send(res, 403, {
      error: "Manager access required."
    });
  }

  if (
    req.method === "GET" &&
    url === "/api/session"
  ) {
    return send(res, 200, {
      user: userView(findUser(db, actor.id), db)
    });
  }

  if (
    req.method === "GET" &&
    url === "/api/dashboard"
  ) {
    const user = findUser(db, actor.id);

    const tasks =
      actor.role === "admin"
        ? db.tasks
        : db.tasks.filter(task => task.employeeId === actor.id);

    return send(res, 200, {
      user: userView(user, db),

      users:
        actor.role === "admin"
          ? db.users
              .filter(item => item.role === "employee")
              .map(item => userView(item, db))
          : [],

      branches:
        actor.role === "admin"
          ? db.branches.map(branch => branchView(db, branch))
          : (user.branchIds || [])
              .map(id => findBranch(db, id))
              .filter(Boolean)
              .map(branch => branchView(db, branch)),

      tasks: tasks.map(task => taskView(task, db)),

      performance: performanceView(
        db,
        tasks,
        actor.role === "admin" ? null : actor.id
      ),

      notifications: db.notifications
        .filter(note => note.userId === actor.id)
        .slice(0, 50),

      history:
        actor.role === "admin"
          ? db.taskHistory.slice(0, 100)
          : []
    });
  }

  if (
    req.method === "GET" &&
    url === "/api/history" &&
    actor.role === "admin"
  ) {
    return send(res, 200, {
      history: db.taskHistory.slice(0, 200).map(item => ({
        ...item,

        taskTitle:
          db.tasks.find(task => task.id === item.taskId)?.title ||
          "Deleted task",

        changedByName:
          findUser(db, item.changedBy)?.name || "Unknown"
      }))
    });
  }

  return send(res, 404, {
    error: "The requested API route was not found."
  });
}

/* =========================================================
   VERCEL SERVER HANDLER
   ========================================================= */

async function api(req, res, url) {
  const db = await getDatabase();

  if (
    req.method === "POST" &&
    url === "/api/login"
  ) {
    const input = await requestBody(req);

    const user = db.users.find(
      item =>
        String(item.userId).toLowerCase() ===
        String(input.userId || "").trim().toLowerCase()
    );

    if (
      !user ||
      !user.active ||
      !verify(
        String(input.password || ""),
        user.passwordHash
      )
    ) {
      return send(res, 401, {
        error: "Invalid credentials or inactive account."
      });
    }

    const token = crypto.randomBytes(32).toString("hex");

    sessions.set(token, {
      id: user.id,
      role: user.role
    });

    return send(
      res,
      200,
      {
        user: userView(user, db)
      },
      {
        "Set-Cookie":
          `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`
      }
    );
  }

  if (
    req.method === "POST" &&
    url === "/api/logout"
  ) {
    const cookies = parseCookies(req);

    sessions.delete(cookies.session);

    return send(
      res,
      200,
      { ok: true },
      {
        "Set-Cookie":
          "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
      }
    );
  }

  const actor = requireUser(req, res);

  if (!actor) return;

  if (
    actor.role !== "admin" &&
    (
      url.startsWith("/api/users") ||
      url.startsWith("/api/branches") ||
      (url === "/api/tasks" && req.method === "POST") ||
      url === "/api/history"
    )
  ) {
    return send(res, 403, {
      error: "Manager access required."
    });
  }

  if (
    req.method === "GET" &&
    url === "/api/session"
  ) {
    return send(res, 200, {
      user: userView(findUser(db, actor.id), db)
    });
  }

  /*
    CREATE AND ASSIGN TASK
  */

  if (
    req.method === "POST" &&
    url === "/api/tasks"
  ) {
    if (actor.role !== "admin") {
      return send(res, 403, {
        error: "Manager access required."
      });
    }

    const input = await requestBody(req);

    const employeeIds = Array.isArray(input.employeeIds)
      ? input.employeeIds
      : input.employeeId
        ? [input.employeeId]
        : [];

    const title = String(input.title || "").trim();

    if (!title) {
      return send(res, 400, {
        error: "Task title is required."
      });
    }

    if (employeeIds.length === 0) {
      return send(res, 400, {
        error: "Please select at least one employee."
      });
    }

    const assignmentGroupId = uid("group");
    const createdTasks = [];

    for (const employeeId of employeeIds) {
      const employee = findUser(db, employeeId);

      if (!employee || employee.role !== "employee") {
        continue;
      }

      const task = {
        id: uid("task"),
        assignmentGroupId,
        title,
        description: String(input.description || ""),
        employeeId: employee.id,
        branchId: input.branchId || null,
        status: STATUSES.includes(input.status)
          ? input.status
          : "Not Started",
        priority: PRIORITIES.includes(input.priority)
          ? input.priority
          : "Medium",
        progress: validProgress(input.progress)
          ? Number(input.progress)
          : 0,
        dueDate: input.dueDate || null,
        createdBy: actor.id,
        createdAt: now(),
        updatedAt: now()
      };

      db.tasks.unshift(task);

      log(
        db,
        task.id,
        actor.id,
        "created",
        null,
        task
      );

      notify(
        db,
        employee.id,
        "task_assigned",
        "New task assigned",
        `You have been assigned: ${task.title}`
      );

      createdTasks.push(task);
    }

    if (createdTasks.length === 0) {
      return send(res, 400, {
        error: "No valid employees were found."
      });
    }

    await writeGoogleDatabase(db);

    return send(res, 201, {
      tasks: createdTasks.map(task =>
        taskView(task, db)
      )
    });
  }

  /*
    DASHBOARD
  */

  if (
    req.method === "GET" &&
    url === "/api/dashboard"
  ) {
    const user = findUser(db, actor.id);

    const tasks =
      actor.role === "admin"
        ? db.tasks
        : db.tasks.filter(
            task => task.employeeId === actor.id
          );

    return send(res, 200, {
      user: userView(user, db),

      users:
        actor.role === "admin"
          ? db.users
              .filter(item => item.role === "employee")
              .map(item => userView(item, db))
          : [],

      branches:
        actor.role === "admin"
          ? db.branches.map(branch =>
              branchView(db, branch)
            )
          : (user.branchIds || [])
              .map(id => findBranch(db, id))
              .filter(Boolean)
              .map(branch => branchView(db, branch)),

      tasks: tasks.map(task =>
        taskView(task, db)
      ),

      performance: performanceView(
        db,
        tasks,
        actor.role === "admin" ? null : actor.id
      ),

      notifications: db.notifications
        .filter(note => note.userId === actor.id)
        .slice(0, 50),

      history:
        actor.role === "admin"
          ? db.taskHistory.slice(0, 100)
          : []
    });
  }

  /*
    TASK HISTORY
  */
  if (
    req.method === "POST" &&
    url === "/api/tasks"
  ) {
    if (actor.role !== "admin") {
      return send(res, 403, {
        error: "Manager access required."
      });
    }

    const input = await requestBody(req);

    const employeeIds = Array.isArray(input.employeeIds)
      ? input.employeeIds
      : input.employeeId
        ? [input.employeeId]
        : [];

    const title = String(input.title || "").trim();

    if (!title) {
      return send(res, 400, {
        error: "Task title is required."
      });
    }

    if (employeeIds.length === 0) {
      return send(res, 400, {
        error: "Please select at least one employee."
      });
    }

    const assignmentGroupId = uid("group");
    const createdTasks = [];

    for (const employeeId of employeeIds) {
      const employee = findUser(db, employeeId);

      if (!employee || employee.role !== "employee") {
        continue;
      }

      const task = {
        id: uid("task"),
        assignmentGroupId,
        title,
        description: String(input.description || ""),
        employeeId: employee.id,
        branchId: input.branchId || null,
        status: STATUSES.includes(input.status)
          ? input.status
          : "Not Started",
        priority: PRIORITIES.includes(input.priority)
          ? input.priority
          : "Medium",
        progress: validProgress(input.progress)
          ? Number(input.progress)
          : 0,
        dueDate: input.dueDate || null,
        createdBy: actor.id,
        createdAt: now(),
        updatedAt: now()
      };

      db.tasks.unshift(task);

      log(
        db,
        task.id,
        actor.id,
        "created",
        null,
        task
      );

      notify(
        db,
        employee.id,
        "task_assigned",
        "New task assigned",
        `You have been assigned: ${task.title}`
      );

      createdTasks.push(task);
    }

    if (createdTasks.length === 0) {
      return send(res, 400, {
        error: "No valid employees were found."
      });
    }

    await writeGoogleDatabase(db);

    return send(res, 201, {
      tasks: createdTasks.map(task =>
        taskView(task, db)
      )
    });
  }
  if (
    req.method === "GET" &&
    url === "/api/history" &&
    actor.role === "admin"
  ) {
    return send(res, 200, {
      history: db.taskHistory
        .slice(0, 200)
        .map(item => ({
          ...item,

          taskTitle:
            db.tasks.find(
              task => task.id === item.taskId
            )?.title || "Deleted task",

          changedByName:
            findUser(db, item.changedBy)?.name ||
            "Unknown"
        }))
    });
  }

  return send(res, 404, {
    error: "The requested API route was not found."
  });
}
