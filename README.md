# Employee Task Dashboard

A small-company employee task manager with a Node.js API, persistent JSON database, hashed passwords, cookie sessions, and a responsive browser dashboard.

## Run locally

```bash
npm start
```

Open `http://localhost:3000`.

Demo accounts:

- Manager: `admin` / `admin123`
- Matrix IT Support admin: `matrix` / `matrix1234`
- Employees: `SP001`, `UT002`, `AS003`, `SR004`, `GE005`, `PR006`, `SI007`, `PR008`, `RI009`, `CH010`, `NA011`, `NE012`, `KA013`, `DE014` / `employee123`

These are temporary demo credentials. The password can be changed from the account menu after signing in. The first server start creates `data.json` with the 14 requested employees, two admin accounts, and five branches, but no employee-to-branch assignments or tasks. It is intentionally ignored from source control because it contains live application data.

## Deployment

The app is intentionally dependency-light and can run on any Node 18+ host. For production, place it behind HTTPS, set a strong session store/secret, and replace the JSON repository with PostgreSQL or another managed database. The API keeps authorization checks server-side, hashes passwords with Node's `scrypt`, and never returns password hashes to the browser.