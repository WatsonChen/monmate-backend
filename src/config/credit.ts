// 點數錢包最低可用餘額：帳戶層級的臨時額度（最多可先使用 3 點）。
// 注意：不要把「執行時會用到的值」放進 @monmate/types——那個套件只有型別，
// 它的 src/index.js 是空殼；Vercel 不會打包而是直接用 Node 載入，從那裡匯入值會在啟動時崩潰。
export const CREDIT_FLOOR = -3;
