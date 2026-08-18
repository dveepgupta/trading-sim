// ─────────────────────────────────────────────
//  Firebase Configuration
// ─────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyBGpCLrRPyQbo5goUGt7oada3EVJnz4H6Y",
  authDomain: "trading-sim-185a8.firebaseapp.com",
  projectId: "trading-sim-185a8",
  storageBucket: "trading-sim-185a8.firebasestorage.app",
  messagingSenderId: "274291579739",
  appId: "1:274291579739:web:be70ac4dc48e547658587e"
};

firebase.initializeApp(firebaseConfig);

const db   = firebase.firestore();
const auth = firebase.auth();

// Firestore settings
db.settings({ ignoreUndefinedProperties: true });

// ─────────────────────────────────────────────
//  Collection / Document path constants
// ─────────────────────────────────────────────
const PATHS = {
  session:    () => db.doc('config/session'),
  users:      ()  => db.collection('users'),
  user:       (uid) => db.doc(`users/${uid}`),
  portfolio:  (uid) => db.doc(`portfolios/${uid}`),
  prices:     ()  => db.collection('prices'),
  price:      (sym) => db.doc(`prices/${sym}`),
  bids:       (sym) => db.collection(`orderBook/${sym}/bids`),
  asks:       (sym) => db.collection(`orderBook/${sym}/asks`),
  trades:     ()  => db.collection('trades'),
  bilateral:  ()  => db.collection('bilateralOrders'),
  news:       ()  => db.collection('newsEvents'),
  leaderboard:()  => db.collection('leaderboard'),
};
