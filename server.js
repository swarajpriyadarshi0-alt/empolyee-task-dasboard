const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

const INDEX_FILE = path.join(__dirname, 'index.html');

const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const SHEET_RANGE = 'A1';

const sessions = new Map();

const EMPLOYEE_NAMES = [
  'Swaraj Priyadarshi',
  'Utkarsh',
  'Aditi Sahu',
  'Sristi',
  'Geeteka',
  'Prerna',
  'Siddhi',
  'Prem',
  'Riya',
  'Chintu',
  'Nashrah',
  'Neha',
  'Kanhaiya',
  'Deepali'
];

const BRANCH_NAMES = [
  'Sec 14',
  'Noida 16',
  'Asaf Ali',
  'DLF CP',
  'Ballabgarh'
];

const STATUSES = [
  'Not Started',
  'In Progress',
  'Completed',
  'On Hold',
  'Pending Review'
];

const PRIORITIES = [
  'Low',
  'Medium',
  'High',
  'Urgent'
];

const now = () => new Date().toISOString();

const uid = prefix =>
  `${prefix}_${crypto.randomBytes(5).toString('hex')}`;

const hash = (password, salt) =>
  `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;

const passwordHash = (
  password,
  salt = crypto.randomBytes(16).toString('hex')
) => Promise.resolve(hash(password, salt));

function verify(password, stored) {
  const [salt, key] = String(stored || '').split(':');

  if (!salt || !key) return false;

  try {
    const derived = crypto.scryptSync(password, salt, 64);
    const storedBuffer = Buffer.from(key, 'hex');

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
    'Content-Type': 'application/json',
    ...headers
  });

  res.end(JSON.stringify(payload));
}

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .filter(Boolean)
      .map(value => {
        const [key, ...rest] = value.trim().split('=');
        return [
          key,
          decodeURIComponent(rest.join('='))
        ];
      })
  );
}

function requestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';

    req.on('data', chunk => {
      raw += chunk;
    });

    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid request body'));
      }
    });
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
    id: uid('note'),
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
    id: uid('history'),
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
      employee?.name || 'Unassigned',

    branchName:
      findBranch(db, task.branchId)?.name || 'Unassigned',

    assignedEmployees: group.map(item => {
      const assignedEmployee =
        findUser(db, item.employeeId);

      return {
        id: item.employeeId,
        name:
          assignedEmployee?.name || 'Unassigned',
        userId:
          assignedEmployee?.userId || '',
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

    completed:
      tasks.filter(
        task => task.status === 'Completed'
      ).length,

    inProgress:
      tasks.filter(
        task => task.status === 'In Progress'
      ).length,

    pending:
      tasks.filter(task =>
        [
          'Not Started',
          'Pending Review',
          'On Hold'
        ].includes(task.status)
      ).length,

    overdue:
      tasks.filter(
        task =>
          task.status !== 'Completed' &&
          task.dueDate <
            now().slice(0, 10)
      ).length,

    progress: tasks.length
      ? Math.round(
          tasks.reduce(
            (sum, task) =>
              sum + Number(task.progress || 0),
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
      user.role === 'employee' &&
      (!employeeId || user.id === employeeId)
  );

  const employeeRows = employees.map(employee => {
    const tasks = visibleTasks.filter(
      task => task.employeeId === employee.id
    );

    const completed = tasks.filter(
      task => task.status === 'Completed'
    ).length;

    return {
      employeeId: employee.id,
      employeeName: employee.name,
      completed,

      pending: tasks.filter(task =>
        [
          'Not Started',
          'Pending Review',
          'On Hold'
        ].includes(task.status)
      ).length,

      inProgress: tasks.filter(
        task => task.status === 'In Progress'
      ).length,

      overdue: tasks.filter(
        task =>
          task.status !== 'Completed' &&
          task.dueDate < now().slice(0, 10)
      ).length,

      total: tasks.length,

      completionRate: tasks.length
        ? Math.round(
            (completed / tasks.length) * 100
          )
        : 0,

      progress: tasks.length
        ? Math.round(
            tasks.reduce(
              (sum, task) =>
                sum + Number(task.progress || 0),
              0
            ) / tasks.length
          )
        : 0
    };
  });

  const completed = visibleTasks.filter(
    task => task.status === 'Completed'
  ).length;

  return {
    employees: employeeRows,

    summary: {
      totalTasks: visibleTasks.length,
      completed,

      pending: visibleTasks.filter(task =>
        [
          'Not Started',
          'Pending Review',
          'On Hold'
        ].includes(task.status)
      ).length,

      inProgress: visibleTasks.filter(
        task => task.status === 'In Progress'
      ).length,

      overdue: visibleTasks.filter(
        task =>
          task.status !== 'Completed' &&
          task.dueDate < now().slice(0, 10)
      ).length,

      completionRate: visibleTasks.length
        ? Math.round(
            (completed / visibleTasks.length) * 100
          )
        : 0,

      progress: visibleTasks.length
        ? Math.round(
            visibleTasks.reduce(
              (sum, task) =>
                sum + Number(task.progress || 0),
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
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function createGoogleJWT() {
  if (
    !GOOGLE_SERVICE_ACCOUNT_EMAIL ||
    !GOOGLE_PRIVATE_KEY
  ) {
    throw new Error(
      'Google service account environment variables are missing.'
    );
  }

  const header = base64Url(
    JSON.stringify({
      alg: 'RS256',
      typ: 'JWT'
    })
  );

  const claim = base64Url(
    JSON.stringify({
      iss: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      scope:
        'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      exp:
        Math.floor(Date.now() / 1000) + 3600,
      iat:
        Math.floor(Date.now() / 1000)
    })
  );

  const unsigned = `${header}.${claim}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);

  const signature = signer
    .sign(GOOGLE_PRIVATE_KEY, 'base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${unsigned}.${signature}`;
}

async function getGoogleAccessToken() {
  const jwt = createGoogleJWT();

  const response = await fetch(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',

      headers: {
        'Content-Type':
          'application/x-www-form-urlencoded'
      },

      body:
        `grant_type=${encodeURIComponent(
          'urn:ietf:params:oauth:grant-type:jwt-bearer'
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
        'Unknown error'
      }`
    );
  }

  return data.access_token;
}

async function readGoogleDatabase() {
  if (!GOOGLE_SHEET_ID) {
    throw new Error(
      'GOOGLE_SHEET_ID environment variable is missing.'
    );
  }

  const token =
    await getGoogleAccessToken();

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
        data.error?.message || 'Unknown error'
      }`
    );
  }

  const value = data.values?.[0]?.[0];

  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    throw new Error(
      'The data stored in Google Sheet A1 is not valid JSON.'
    );
  }
}

async function writeGoogleDatabase(db) {
  if (!GOOGLE_SHEET_ID) {
    throw new Error(
      'GOOGLE_SHEET_ID environment variable is missing.'
    );
  }

  const token =
    await getGoogleAccessToken();

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/` +
    `${encodeURIComponent(GOOGLE_SHEET_ID)}` +
    `/values/${encodeURIComponent(SHEET_RANGE)}` +
    `?valueInputOption=RAW`;

  const response = await fetch(url, {
    method: 'PUT',

    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },

    body: JSON.stringify({
      range: SHEET_RANGE,
      majorDimension: 'ROWS',

      values: [
        [
          JSON.stringify(db)
        ]
      ]
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Google Sheets write failed: ${
        data.error?.message || 'Unknown error'
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
      id: 'usr_admin',
      name: 'Ankit Maheswari',
      userId: 'admin',
      role: 'admin',
      passwordHash:
        hash('admin123', 'admin-demo-salt'),
      active: true,
      branchIds: [],
      createdAt,
      updatedAt: createdAt
    },

    {
      id: 'usr_matrix_admin',
      name: 'Matrix IT Support',
      userId: 'matrix',
      role: 'admin',
      passwordHash:
        hash(
          'matrix1234',
          'matrix-demo-salt'
        ),
      active: true,
      branchIds: [],
      createdAt,
      updatedAt: createdAt
    }
  ];

  EMPLOYEE_NAMES.forEach(
    (name, index) => {
      const words = name.split(' ');

      const code = (
        words.length > 1
          ? words
              .map(word => word[0])
              .join('')
          : name.slice(0, 2)
      )
        .slice(0, 2)
        .toUpperCase();

      users.push({
        id:
          `usr_emp_${String(
            index + 1
          ).padStart(3, '0')}`,

        name,

        userId:
          `${code}${String(
            index + 1
          ).padStart(3, '0')}`,

        role: 'employee',

        passwordHash:
          hash(
            'employee123',
            `employee-${index + 1}`
          ),

        active: true,

        branchIds: [],

        createdAt,

        updatedAt: createdAt
      });
    }
  );

  return {
    users,

    branches:
      BRANCH_NAMES.map(name => ({
        id: uid('branch'),
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
    /*
      If an old local data.json exists, use it
      only for the first migration.
    */

    const oldFile =
      path.join(__dirname, 'data.json');

    if (fs.existsSync(oldFile)) {
      try {
        db = JSON.parse(
          fs.readFileSync(
            oldFile,
            'utf8'
          )
        );
      } catch {
        db = seed();
      }
    } else {
      db = seed();
    }

    if (!db.users) db.users = [];
    if (!db.branches) db.branches = [];
    if (!db.tasks) db.tasks = [];
    if (!db.taskHistory)
      db.taskHistory = [];
    if (!db.notifications)
      db.notifications = [];

    await writeGoogleDatabase(db);
  }

  /*
    Basic safety migration.
  */

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

  const admin =
    db.users.find(
      user => user.role === 'admin'
    );

  if (
    admin &&
    admin.name !== 'Ankit Maheswari'
  ) {
    admin.name =
      'Ankit Maheswari';

    admin.updatedAt = now();

    changed = true;
  }

  if (
    !db.users.some(
      user =>
        String(user.userId)
          .toLowerCase() === 'matrix'
    )
  ) {
    const createdAt = now();

    db.users.push({
      id: 'usr_matrix_admin',
      name: 'Matrix IT Support',
      userId: 'matrix',
      role: 'admin',
      passwordHash:
        hash(
          'matrix1234',
          'matrix-demo-salt'
        ),
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

  return sessions.get(
    cookies.session
  );
}

function requireUser(
  req,
  res,
  role
) {
  const user =
    currentUser(req);

  if (!user) {
    send(res, 401, {
      error:
        'Please sign in.'
    });

    return null;
  }

  if (
    role &&
    user.role !== role
  ) {
    send(res, 403, {
      error:
        'Manager access required.'
    });

    return null;
  }

  return user;
}

/* =========================================================
   API
   ========================================================= */

async function api(
  req,
  res,
  url
) {
  const db =
    await getDatabase();

  /* LOGIN */

  if (
    req.method === 'POST' &&
    url === '/api/login'
  ) {
    const input =
      await requestBody(req);

    const user =
      db.users.find(
        item =>
          String(item.userId)
            .toLowerCase() ===
          String(
            input.userId || ''
          )
            .trim()
            .toLowerCase()
      );

    if (
      !user ||
      !user.active ||
      !verify(
        String(
          input.password || ''
        ),
        user.passwordHash
      )
    ) {
      return send(res, 401, {
        error:
          'Invalid credentials or inactive account.'
      });
    }

    const token =
      crypto.randomBytes(32)
        .toString('hex');

    sessions.set(
      token,
      {
        id: user.id,
        role: user.role
      }
    );

    return send(
      res,
      200,
      {
        user:
          userView(
            user,
            db
          )
      },
      {
        'Set-Cookie':
          `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`
      }
    );
  }

  /* LOGOUT */

  if (
    req.method === 'POST' &&
    url === '/api/logout'
  ) {
    const cookies =
      parseCookies(req);

    sessions.delete(
      cookies.session
    );

    return send(
      res,
      200,
      { ok: true },
      {
        'Set-Cookie':
          'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'
      }
    );
  }

  const actor =
    requireUser(
      req,
      res
    );

  if (!actor) return;

  /* EMPLOYEE ACCESS RESTRICTIONS */

  if (
    actor.role !== 'admin' &&
    (
      url.startsWith('/api/users') ||
      url.startsWith('/api/branches') ||
      (
        url === '/api/tasks' &&
        req.method === 'POST'
      ) ||
      url === '/api/history'
    )
  ) {
    return send(
      res,
      403,
      {
        error:
          'Manager access required.'
      }
    );
  }

  /* SESSION */

  if (
    req.method === 'GET' &&
    url === '/api/session'
  ) {
    return send(
      res,
      200,
      {
        user:
          userView(
            findUser(
              db,
              actor.id
            ),
            db
          )
      }
    );
  }

  /* DASHBOARD */

  if (
    req.method === 'GET' &&
    url === '/api/dashboard'
  ) {
    const user =
      findUser(
        db,
        actor.id
      );

    const tasks =
      actor.role === 'admin'
        ? db.tasks
        : db.tasks.filter(
            task =>
              task.employeeId ===
              actor.id
          );

    return send(
      res,
      200,
      {
        user:
          userView(
            user,
            db
          ),

        users:
          actor.role === 'admin'
            ? db.users
                .filter(
                  item =>
                    item.role ===
                    'employee'
                )
                .map(
                  item =>
                    userView(
                      item,
                      db
                    )
                )
            : [],

        branches:
          actor.role === 'admin'
            ? db.branches.map(
                branch =>
                  branchView(
                    db,
                    branch
                  )
              )
            : (user.branchIds || [])
                .map(
                  id =>
                    findBranch(
                      db,
                      id
                    )
                )
                .filter(Boolean)
                .map(
                  branch =>
                    branchView(
                      db,
                      branch
                    )
                ),

        tasks:
          tasks.map(
            task =>
              taskView(
                task,
                db
              )
          ),

        performance:
          performanceView(
            db,
            tasks,
            actor.role ===
              'admin'
              ? null
              : actor.id
          ),

        notifications:
          db.notifications
            .filter(
              note =>
                note.userId ===
                actor.id
            )
            .slice(0, 50),

        history:
          actor.role === 'admin'
            ? db.taskHistory.slice(
                0,
                100
              )
            : []
      }
    );
  }

  /* HISTORY */

  if (
    req.method === 'GET' &&
    url === '/api/history' &&
    actor.role === 'admin'
  ) {
    return send(
      res,
      200,
      {
        history:
          db.taskHistory
            .slice(0, 200)
            .map(item => ({
              ...item,

              taskTitle:
                db.tasks.find(
                  task =>
                    task.id ===
                    item.taskId
                )?.title ||
                'Deleted task',

              changedByName:
                findUser(
                  db,
                  item.changedBy
                )?.name ||
                'Unknown'
            }))
      }
    );
  }

  /* =====================================================
     USERS
     ===================================================== */

  if (
    req.method === 'POST' &&
    url === '/api/users' &&
    actor.role === 'admin'
  ) {
    const input =
      await requestBody(req);

    if (
      !input.name?.trim() ||
      !input.userId?.trim() ||
      !input.password ||
      input.password.length < 8
    ) {
      return send(
        res,
        400,
        {
          error:
            'Name, User ID, and a password of at least 8 characters are required.'
        }
      );
    }

    if (
      db.users.some(
        item =>
          item.userId
            .toLowerCase() ===
          input.userId
            .trim()
            .toLowerCase()
      )
    ) {
      return send(
        res,
        409,
        {
          error:
            'That User ID is already in use.'
        }
      );
    }

    const branchIds =
      activeBranchIds(
        db,
        input.branchIds
      );

    const created = {
      id: uid('usr'),

      name:
        input.name.trim(),

      userId:
        input.userId.trim(),

      role: 'employee',

      passwordHash:
        await passwordHash(
          input.password
        ),

      active:
        input.active !== false,

      branchIds,

      createdAt: now(),
      updatedAt: now()
    };

    db.users.push(created);

    await writeGoogleDatabase(
      db
    );

    return send(
      res,
      201,
      {
        message:
          'Employee added successfully.',

        user:
          userView(
            created,
            db
          )
      }
    );
  }

  /* UPDATE / DELETE USER */

  const userMatch =
    url.match(
      /^\/api\/users\/([^/]+)$/
    );

  if (
    userMatch &&
    actor.role === 'admin'
  ) {
    const target =
      findUser(
        db,
        userMatch[1]
      );

    if (
      !target ||
      target.role !== 'employee'
    ) {
      return send(
        res,
        404,
        {
          error:
            'Employee not found.'
        }
      );
    }

    if (
      req.method === 'PATCH'
    ) {
      const input =
        await requestBody(req);

      if (
        input.name !==
          undefined &&
        !String(
          input.name
        ).trim()
      ) {
        return send(
          res,
          400,
          {
            error:
              'Employee name is required.'
          }
        );
      }

      if (input.name) {
        target.name =
          input.name.trim();
      }

      if (
        input.active !==
        undefined
      ) {
        target.active =
          Boolean(
            input.active
          );
      }

      if (input.password) {
        if (
          input.password.length <
          8
        ) {
          return send(
            res,
            400,
            {
              error:
                'Password must be at least 8 characters.'
            }
          );
        }

        target.passwordHash =
          await passwordHash(
            input.password
          );
      }

      if (
        Array.isArray(
          input.branchIds
        )
      ) {
        if (
          input.branchIds.some(
            id =>
              !findBranch(
                db,
                id
              )?.active
          )
        ) {
          return send(
            res,
            400,
            {
              error:
                'Employees can only be assigned to active branches.'
            }
          );
        }

        target.branchIds = [
          ...new Set(
            input.branchIds
          )
        ];
      }

      target.updatedAt =
        now();

      await writeGoogleDatabase(
        db
      );

      return send(
        res,
        200,
        {
          user:
            userView(
              target,
              db
            )
        }
      );
    }

    if (
      req.method === 'DELETE'
    ) {
      target.active = false;
      target.updatedAt = now();

      await writeGoogleDatabase(
        db
      );

      return send(
        res,
        200,
        { ok: true }
      );
    }
  }

  /* =====================================================
     BRANCHES
     ===================================================== */

  if (
    req.method === 'POST' &&
    url === '/api/branches' &&
    actor.role === 'admin'
  ) {
    const input =
      await requestBody(req);

    const name =
      String(
        input.name || ''
      ).trim();

    if (!name) {
      return send(
        res,
        400,
        {
          error:
            'Branch name is required.'
        }
      );
    }

    if (
      db.branches.some(
        branch =>
          branch.active &&
          branch.name.toLowerCase() ===
            name.toLowerCase()
      )
    ) {
      return send(
        res,
        409,
        {
          error:
            'That active branch already exists.'
        }
      );
    }

    const branch = {
      id: uid('branch'),
      name,
      active: true,
      createdAt: now(),
      updatedAt: now()
    };

    db.branches.push(
      branch
    );

    await writeGoogleDatabase(
      db
    );

    return send(
      res,
      201,
      {
        message:
          'Branch added successfully.',

        branch:
          branchView(
            db,
            branch
          )
      }
    );
  }

  const branchMatch =
    url.match(
      /^\/api\/branches\/([^/]+)$/
    );

  if (
    branchMatch &&
    actor.role === 'admin'
  ) {
    const branch =
      findBranch(
        db,
        branchMatch[1]
      );

    if (!branch) {
      return send(
        res,
        404,
        {
          error:
            'Branch not found.'
        }
      );
    }

    if (
      req.method === 'PATCH'
    ) {
      const input =
        await requestBody(req);

      if (
        input.name !==
        undefined
      ) {
        const name =
          String(
            input.name
          ).trim();

        if (!name) {
          return send(
            res,
            400,
            {
              error:
                'Branch name is required.'
            }
          );
        }

        if (
          db.branches.some(
            item =>
              item.id !==
                branch.id &&
              item.active &&
              item.name.toLowerCase() ===
                name.toLowerCase()
          )
        ) {
          return send(
            res,
            409,
            {
              error:
                'That active branch already exists.'
            }
          );
        }

        branch.name =
          name;
      }

      if (
        input.active !==
        undefined
      ) {
        branch.active =
          Boolean(
            input.active
          );

        if (!branch.active) {
          db.users.forEach(
            item => {
              item.branchIds =
                (
                  item.branchIds ||
                  []
                ).filter(
                  id =>
                    id !==
                    branch.id
                );
            }
          );
        }
      }

      branch.updatedAt =
        now();

      await writeGoogleDatabase(
        db
      );

      return send(
        res,
        200,
        {
          branch:
            branchView(
              db,
              branch
            )
        }
      );
    }

    if (
      req.method === 'DELETE'
    ) {
      branch.active =
        false;

      db.users.forEach(
        item => {
          item.branchIds =
            (
              item.branchIds ||
              []
            ).filter(
              id =>
                id !==
                branch.id
            );
        }
      );

      await writeGoogleDatabase(
        db
      );

      return send(
        res,
        200,
        { ok: true }
      );
    }
  }

  /* =====================================================
     CREATE TASK
     ===================================================== */

  if (
    req.method === 'POST' &&
    url === '/api/tasks' &&
    actor.role === 'admin'
  ) {
    const input =
      await requestBody(req);

    const employeeIds = [
      ...new Set(
        Array.isArray(
          input.employeeIds
        )
          ? input.employeeIds
          : [
              input.employeeId ||
                input.assigneeId
            ].filter(Boolean)
      )
    ];

    /*
      BRANCH LIABILITY RULE:
      If a branch is selected, automatically include
      all active employees assigned to that branch.
    */

    const branch =
      findBranch(
        db,
        input.branchId
      );

    if (!branch?.active) {
      return send(
        res,
        400,
        {
          error:
            'Choose an active branch.'
        }
      );
    }

    const branchEmployees =
      db.users.filter(
        employee =>
          employee.role ===
            'employee' &&
          employee.active &&
          (
            employee.branchIds ||
            []
          ).includes(
            branch.id
          )
      );

    branchEmployees.forEach(
      employee => {
        if (
          !employeeIds.includes(
            employee.id
          )
        ) {
          employeeIds.push(
            employee.id
          );
        }
      }
    );

    const employees =
      employeeIds.map(
        id =>
          findUser(
            db,
            id
          )
      );

    if (
      !input.title?.trim() ||
      !employeeIds.length ||
      employees.some(
        employee =>
          !employee ||
          employee.role !==
            'employee' ||
          !employee.active
      )
    ) {
      return send(
        res,
        400,
        {
          error:
            'Choose at least one active employee and enter a task title.'
        }
      );
    }

    if (
      !validProgress(
        input.progress ??
          0
      )
    ) {
      return send(
        res,
        400,
        {
          error:
            'Progress must be a whole number between 0 and 100.'
        }
      );
    }

    if (
      !input.dueDate ||
      Number.isNaN(
        new Date(
          input.dueDate
        ).getTime()
      )
    ) {
      return send(
        res,
        400,
        {
          error:
            'Choose a valid due date.'
        }
      );
    }

    const assignmentGroupId =
      uid('group');

    const createdTasks =
      employees.map(
        employee => {
          const task = {
            id: uid('task'),

            assignmentGroupId,

            employeeId:
              employee.id,

            branchId:
              branch.id,

            title:
              input.title.trim(),

            description:
              input.description?.trim() ||
              '',

            status:
              STATUSES.includes(
                input.status
              )
                ? input.status
                : 'Not Started',

            progress:
              Number(
                input.progress ||
                  0
              ),

            priority:
              PRIORITIES.includes(
                input.priority
              )
                ? input.priority
                : 'Medium',

            assignedDate:
              input.assignedDate ||
              now().slice(
                0,
                10
              ),

            dueDate:
              input.dueDate,

            remarks:
              input.remarks?.trim() ||
              '',

            createdBy:
              actor.id,

            createdAt: now(),

            updatedAt: now(),

            completedAt:
              null
          };

          if (
            task.status ===
            'Completed'
          ) {
            task.progress =
              100;

            task.completedAt =
              now();
          }

          db.tasks.push(
            task
          );

          log(
            db,
            task.id,
            actor.id,
            'Task created',
            '',
            `${task.title} assigned to ${employee.name}`
          );

          notify(
            db,
            employee.id,
            'assigned',
            'New task assigned',
            `${task.title} was assigned to you.`
          );

          return task;
        }
      );

    await writeGoogleDatabase(
      db
    );

    return send(
      res,
      201,
      {
        message:
          'Task assigned successfully.',

        tasks:
          createdTasks.map(
            task =>
              taskView(
                task,
                db
              )
          ),

        task:
          taskView(
            createdTasks[0],
            db
          )
      }
    );
  }

  /* =====================================================
     TASK STATUS
     ===================================================== */

  const statusMatch =
    url.match(
      /^\/api\/tasks\/([^/]+)\/status$/
    );

  if (
    statusMatch &&
    req.method === 'POST'
  ) {
    const task =
      db.tasks.find(
        item =>
          item.id ===
          statusMatch[1]
      );

    if (!task) {
      return send(
        res,
        404,
        {
          error:
            'Task not found.'
        }
      );
    }

    if (
      actor.role !== 'admin' &&
      task.employeeId !==
        actor.id
    ) {
      return send(
        res,
        403,
        {
          error:
            'You can only update your own task assignments.'
        }
      );
    }

    const input =
      await requestBody(req);

    if (
      !STATUSES.includes(
        input.status
      )
    ) {
      return send(
        res,
        400,
        {
          error:
            'Invalid task status.'
        }
      );
    }

    const previousStatus =
      task.status;

    task.status =
      input.status;

    if (
      task.status ===
      'Completed'
    ) {
      task.progress =
        100;

      task.completedAt =
        now();
    } else {
      task.completedAt =
        null;
    }

    task.updatedAt =
      now();

    if (
      previousStatus !==
      task.status
    ) {
      log(
        db,
        task.id,
        actor.id,
        'status changed',
        previousStatus,
        task.status
      );

      if (
        task.status ===
        'Completed'
      ) {
        notify(
          db,
          task.createdBy,
          'completed',
          'Task completed',
          `${task.title} was marked complete.`
        );
      }
    }

    await writeGoogleDatabase(
      db
    );

    return send(
      res,
      200,
      {
        message:
          'Task status saved.',

        task:
          taskView(
            task,
            db
          )
      }
    );
  }

  /* =====================================================
     TASK UPDATE
     ===================================================== */

  const groupedTaskMatch =
    url.match(
      /^\/api\/tasks\/([^/]+)$/
    );

  if (
    groupedTaskMatch &&
    req.method === 'PATCH'
  ) {
    const task =
      db.tasks.find(
        item =>
          item.id ===
          groupedTaskMatch[1]
      );

    if (!task) {
      return send(
        res,
        404,
        {
          error:
            'Task not found.'
        }
      );
    }

    const admin =
      actor.role === 'admin';

    if (
      !admin &&
      task.employeeId !==
        actor.id
    ) {
      return send(
        res,
        403,
        {
          error:
            'You can only update your own tasks.'
        }
      );
    }

    const input =
      await requestBody(req);

    /* EMPLOYEE UPDATE */

    if (!admin) {
      if (
        input.status !==
          undefined &&
        !STATUSES.includes(
          input.status
        )
      ) {
        return send(
          res,
          400,
          {
            error:
              'Invalid task status.'
          }
        );
      }

      if (
        input.progress !==
          undefined &&
        !validProgress(
          input.progress
        )
      ) {
        return send(
          res,
          400,
          {
            error:
              'Progress must be a whole number between 0 and 100.'
          }
        );
      }

      const before = {
        status:
          task.status,

        progress:
          task.progress,

        remarks:
          task.remarks
      };

      if (
        input.status !==
        undefined
      ) {
        task.status =
          input.status;
      }

      if (
        input.progress !==
        undefined
      ) {
        task.progress =
          Number(
            input.progress
          );
      }

      if (
        input.remarks !==
        undefined
      ) {
        task.remarks =
          String(
            input.remarks
          ).trim();
      }

      if (
        task.status ===
        'Completed'
      ) {
        task.progress =
          100;

        task.completedAt ||=
          now();
      } else {
        task.completedAt =
          null;
      }

      task.updatedAt =
        now();

      Object.keys(
        before
      ).forEach(
        field => {
          if (
            String(
              before[field] ??
                ''
            ) !==
            String(
              task[field] ??
                ''
            )
          ) {
            log(
              db,
              task.id,
              actor.id,
              `${field} changed`,
              String(
                before[field] ??
                  ''
              ),
              String(
                task[field] ??
                  ''
              )
            );
          }
        }
      );

      if (
        before.status !==
          'Completed' &&
        task.status ===
          'Completed'
      ) {
        notify(
          db,
          task.createdBy,
          'completed',
          'Task completed',
          `${task.title} was marked complete.`
        );
      }

      await writeGoogleDatabase(
        db
      );

      return send(
        res,
        200,
        {
          task:
            taskView(
              task,
              db
            )
        }
      );
    }

    /* ADMIN GROUP UPDATE */

    const group =
      task.assignmentGroupId
        ? db.tasks.filter(
            item =>
              item.assignmentGroupId ===
              task.assignmentGroupId
          )
        : [task];

    let selectedIds =
      Array.isArray(
        input.employeeIds
      )
        ? [
            ...new Set(
              input.employeeIds
            )
          ]
        : group.map(
            item =>
              item.employeeId
          );

    const branch =
      findBranch(
        db,
        input.branchId ??
          task.branchId
      );

    if (!branch?.active) {
      return send(
        res,
        400,
        {
          error:
            'Choose an active branch.'
        }
      );
    }

    /*
      Branch liability rule for updates.
    */

    const branchEmployees =
      db.users.filter(
        employee =>
          employee.role ===
            'employee' &&
          employee.active &&
          (
            employee.branchIds ||
            []
          ).includes(
            branch.id
          )
      );

    branchEmployees.forEach(
      employee => {
        if (
          !selectedIds.includes(
            employee.id
          )
        ) {
          selectedIds.push(
            employee.id
          );
        }
      }
    );

    const selectedUsers =
      selectedIds.map(
        id =>
          findUser(
            db,
            id
          )
      );

    if (
      !selectedIds.length ||
      selectedUsers.some(
        employee =>
          !employee ||
          employee.role !==
            'employee' ||
          !employee.active
      )
    ) {
      return send(
        res,
        400,
        {
          error:
            'Choose at least one active employee.'
        }
      );
    }

    if (
      input.title !==
        undefined &&
      !String(
        input.title
      ).trim()
    ) {
      return send(
        res,
        400,
        {
          error:
            'Task title is required.'
        }
      );
    }

    if (
      input.priority !==
        undefined &&
      !PRIORITIES.includes(
        input.priority
      )
    ) {
      return send(
        res,
        400,
        {
          error:
            'Invalid task priority.'
        }
      );
    }

    const groupId =
      task.assignmentGroupId ||
      uid('group');

    const existingByEmployee =
      new Map(
        group.map(
          item => [
            item.employeeId,
            item
          ]
        )
      );

    const removed =
      group.filter(
        item =>
          !selectedIds.includes(
            item.employeeId
          )
      );

    removed.forEach(
      item => {
        log(
          db,
          item.id,
          actor.id,
          'Employee removed',
          findUser(
            db,
            item.employeeId
          )?.name || '',
          ''
        );
      }
    );

    db.tasks =
      db.tasks.filter(
        item =>
          !removed.includes(
            item
          )
      );

    selectedUsers.forEach(
      employee => {
        let assignment =
          existingByEmployee.get(
            employee.id
          );

        if (!assignment) {
          assignment = {
            ...task,

            id: uid('task'),

            assignmentGroupId:
              groupId,

            employeeId:
              employee.id,

            status:
              'Not Started',

            progress: 0,

            remarks: '',

            completedAt:
              null,

            createdAt:
              now(),

            updatedAt:
              now()
          };

          db.tasks.push(
            assignment
          );

          log(
            db,
            assignment.id,
            actor.id,
            'Employee added',
            '',
            employee.name
          );

          notify(
            db,
            employee.id,
            'assigned',
            'New task assigned',
            `${assignment.title} was assigned to you.`
          );
        }

        const before = {
          ...assignment
        };

        [
          'branchId',
          'title',
          'description',
          'priority',
          'assignedDate',
          'dueDate'
        ].forEach(
          field => {
            if (
              input[field] !==
              undefined
            ) {
              assignment[field] =
                input[field];
            }
          }
        );

        if (
          assignment.status ===
          'Completed'
        ) {
          assignment.progress =
            100;
        }

        assignment.assignmentGroupId =
          groupId;

        assignment.updatedAt =
          now();

        Object.keys(
          before
        ).forEach(
          field => {
            if (
              String(
                before[field] ??
                  ''
              ) !==
              String(
                assignment[field] ??
                  ''
              )
            ) {
              log(
                db,
                assignment.id,
                actor.id,
                `${field} changed`,
                String(
                  before[field] ??
                    ''
                ),
                String(
                  assignment[field] ??
                    ''
                )
              );
            }
          }
        );
      }
    );

    await writeGoogleDatabase(
      db
    );

    const updated =
      db.tasks.find(
        item =>
          item.id ===
          task.id
      ) ||
      db.tasks.find(
        item =>
          item.assignmentGroupId ===
          groupId
      );

    return send(
      res,
      200,
      {
        message:
          'Task updated successfully.',

        task:
          taskView(
            updated,
            db
          ),

        tasks:
          db.tasks
            .filter(
              item =>
                item.assignmentGroupId ===
                groupId
            )
            .map(
              item =>
                taskView(
                  item,
                  db
                )
            )
      }
    );
  }

  /* =====================================================
     DELETE TASK
     ===================================================== */

  if (
    groupedTaskMatch &&
    req.method === 'DELETE'
  ) {
    const task =
      db.tasks.find(
        item =>
          item.id ===
          groupedTaskMatch[1]
      );

    if (!task) {
      return send(
        res,
        404,
        {
          error:
            'Task not found.'
        }
      );
    }

    if (
      actor.role !== 'admin'
    ) {
      return send(
        res,
        403,
        {
          error:
            'Manager access required.'
        }
      );
    }

    log(
      db,
      task.id,
      actor.id,
      'Task deleted',
      task.title,
      ''
    );

    db.tasks =
      db.tasks.filter(
        item =>
          item.id !==
          task.id
      );

    await writeGoogleDatabase(
      db
    );

    return send(
      res,
      200,
      { ok: true }
    );
  }

  /* =====================================================
     NOTIFICATIONS
     ===================================================== */

  const noteMatch =
    url.match(
      /^\/api\/notifications\/([^/]+)\/read$/
    );

  if (
    req.method === 'POST' &&
    noteMatch
  ) {
    const note =
      db.notifications.find(
        item =>
          item.id ===
            noteMatch[1] &&
          item.userId ===
            actor.id
      );

    if (note) {
      note.read = true;
    }

    await writeGoogleDatabase(
      db
    );

    return send(
      res,
      200,
      { ok: true }
    );
  }

  /* =====================================================
     CHANGE PASSWORD
     ===================================================== */

  if (
    req.method === 'PATCH' &&
    url ===
      '/api/account/password'
  ) {
    const input =
      await requestBody(req);

    if (
      !input.password ||
      input.password.length < 8
    ) {
      return send(
        res,
        400,
        {
          error:
            'New password must be at least 8 characters.'
        }
      );
    }

    const current =
      findUser(
        db,
        actor.id
      );

    current.passwordHash =
      await passwordHash(
        input.password
      );

    current.updatedAt =
      now();

    await writeGoogleDatabase(
      db
    );

    return send(
      res,
      200,
      { ok: true }
    );
  }

  return send(
    res,
    404,
    {
      error:
        'Not found.'
    }
  );
}

/* =========================================================
   SERVER
   ========================================================= */

const server =
  http.createServer(
    async (req, res) => {
      const url =
        new URL(
          req.url,
          `http://${req.headers.host}`
        ).pathname;

      if (
        url.startsWith('/api/')
      ) {
        try {
          await api(
            req,
            res,
            url
          );
        } catch (error) {
          console.error(
            error
          );

          send(
            res,
            500,
            {
              error:
                error.message ||
                'Server error'
            }
          );
        }

        return;
      }

      if (
        req.method === 'GET' &&
        (
          url === '/' ||
          url === '/index.html'
        )
      ) {
        try {
          res.writeHead(
            200,
            {
              'Content-Type':
                'text/html; charset=utf-8'
            }
          );

          return res.end(
            fs.readFileSync(
              INDEX_FILE
            )
          );
        } catch {
          res.writeHead(
            500
          );

          return res.end(
            'index.html not found'
          );
        }
      }

      res.writeHead(404);
      res.end(
        'Not found'
      );
    }
  );

server.listen(
  PORT,
  () =>
    console.log(
      `Employee dashboard running on port ${PORT}`
    )
);
