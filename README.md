# BugSentry

BugSentry is my MERN-stack bug tracking project for the StartupMeu Software Engineer Intern assessment. Its React dashboard manages bug reports through an Express API, and it also includes a small Python code analyzer.

## Features

- Create, view, update, filter, search, and delete issues.
- Store issues in MongoDB with Mongoose when the database connection is available.
- See counts for total, open, critical, and resolved issues.
- Analyze Python code for syntax errors, some unresolved function calls, literal division by zero, and possible division by the length of an empty collection.
- View diagnostic severity, line number, explanation, and a suggested fix when available.

The analyzer uses Python's built-in AST parser and does not execute submitted code. It checks a limited set of patterns, so "No supported issues detected" does not mean the code is bug-free. Changing an issue to "Resolved" updates its workflow status; it does not confirm that the underlying bug was fixed.

## Technologies

- React, JavaScript, and Vite
- Node.js and Express
- MongoDB and Mongoose
- Python 3 and the built-in `ast` module
- CSS

## Setup

You will need Node.js with npm, Python 3, and MongoDB Atlas or a local MongoDB server.

From the project root, copy the environment example:

```powershell
Copy-Item server/.env.example server/.env
```

Edit `server/.env` and replace the placeholders with your own values:

```env
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster-url>/<database>?retryWrites=true&w=majority
PORT=5000
CLIENT_ORIGIN=http://localhost:5173
PYTHON_EXECUTABLE=C:\path\to\python.exe
```

- `MONGODB_URI` is required. Use your Atlas connection string or a local MongoDB URI. Replace every placeholder and URL-encode special characters in the database password.
- `PORT` defaults to `5000`.
- `CLIENT_ORIGIN` defaults to `http://localhost:5173`.
- `PYTHON_EXECUTABLE` can point to your Python 3 executable. If it is unset, this Windows development setup uses `C:\Users\adith\AppData\Local\Python\bin\python.exe`; other platforms use `python3`.
- The frontend reads `VITE_API_URL`, which defaults to `http://localhost:5000`. Set it in a local client file such as `client/.env.local` to use another API address.

Keep `server/.env` private. Do not commit it or share its credentials. The checked-in `server/.env.example` contains placeholders only.

## Install and run

Open two PowerShell terminals in the project root.

In the first terminal, install and start the backend:

```powershell
Set-Location server
npm.cmd install
npm.cmd start
```

In the second terminal, install and start the frontend:

```powershell
Set-Location client
npm.cmd install
npm.cmd run dev
```

Open the Vite address printed in the client terminal, usually `http://localhost:5173`.

The backend has a `GET /api/health` endpoint. It confirms that the API process responds, but it does not confirm a MongoDB connection. Issue endpoints return a service-unavailable response when the database is unavailable.

## Run checks

From `server`, run the backend syntax check, API tests, and Python analyzer tests:

```powershell
npm.cmd run check
npm.cmd test
python -m unittest discover -s test -p "test_python_analyzer.py" -v
```

From `client`, run the production build:

```powershell
npm.cmd run build
```

The latest recorded backend check passed, all 19 backend tests passed, and the frontend production build passed. The API tests use a test issue model, so those results do not prove that a live MongoDB connection works.

## AI Development Experience

I used Code0 during development to work on focused changes and check the results. I reviewed suggestions against the project files and ran the available checks instead of assuming the changes were correct. When normal MongoDB startup failed on Windows, I investigated the difference between Node.js and Windows DNS and kept the problem open rather than treating a separate successful connection as proof that startup was fixed.

The local Code0 task notes mark these three tasks complete:

- Added the Python analysis API.
- Expanded analyzer diagnostics and issue counts, with regression tests.
- Refined dashboard font sizes while keeping the layout responsive.

For this README, I also used Code0 to check the setup values, commands, and task notes against the project files. I have not listed other planned work as completed Code0 implementation.

## Current MongoDB limitation

The latest normal `npm.cmd start` run in my Windows setup failed during MongoDB server selection. A separate Node.js connection using the Windows DNS resolver succeeded, but that did not verify the normal startup path. Until normal startup connects successfully, live issue persistence through the usual run instructions remains unverified.
