// Local development only: npm run dev
import app from './app.js'
const port = process.env.PORT || 4000
app.listen(port, () => console.log(`CrashAid API on :${port}`))
