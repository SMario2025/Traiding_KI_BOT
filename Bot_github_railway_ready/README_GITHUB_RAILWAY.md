# GitHub + Railway Deployment

## GitHub
1. Create a new GitHub repo.
2. Upload all project files except `.env`, `data/`, and `node_modules/`.
3. Push the repo to `main`.

## Railway
1. Create a new project in Railway.
2. Choose **Deploy from GitHub repo** and connect this repository.
3. Add the required environment variables from your local `.env`.
4. Create a **Volume** and mount it to `/data`.
5. Set `DATA_DIR=/data` in Railway variables.
6. Deploy the service.

## Important variables
- `PORT` is provided by Railway automatically.
- `DATA_DIR=/data`
- `DB_PATH=/data/bot.db` (optional if `DATA_DIR` is set)
- Your Solana / wallet / trading variables from `.env`

## Start behavior
Railway uses one process here:
- dashboard on `0.0.0.0:$PORT`
- bot loop in the same service

## Notes
- Persistent learning data should live on the Railway volume.
- Do not commit your real `.env` to GitHub.
