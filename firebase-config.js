/**
 * firebase-config.js — Cấu hình Firebase cho ứng dụng Quản Lý Vụ Việc
 * =====================================================================
 * File này chứa thông tin kết nối Firebase. Đặt cùng thư mục với index.html.
 *
 * BẢO MẬT:
 *   - Không commit file này lên Git công khai nếu dự án nhạy cảm
 *   - Thêm "firebase-config.js" vào .gitignore nếu cần
 *   - API Key Firebase web là public by design — bảo mật thực sự
 *     nằm ở Firestore Security Rules (xem bên dưới)
 *
 * FIRESTORE SECURITY RULES (Firebase Console → Firestore → Rules):
 * ----------------------------------------------------------------
 *   rules_version = '2';
 *   service cloud.firestore {
 *     match /databases/{database}/documents {
 *       match /{document=**} {
 *         allow read, write: if request.auth != null;
 *       }
 *     }
 *   }
 *
 * CÁCH CẬP NHẬT:
 *   1. Vào https://console.firebase.google.com
 *   2. Chọn project → Project Settings → Your apps
 *   3. Copy firebaseConfig và paste vào đây
 * =====================================================================
 */

window.__FIREBASE_CONFIG__ = {
  apiKey:            "AIzaSyD5JPK3Pgj2RQjXih6KwXv_dRhEkX0myHA",
  authDomain:        "qlvv-captb-2026.firebaseapp.com",
  projectId:         "qlvv-captb-2026",
  storageBucket:     "qlvv-captb-2026.firebasestorage.app",
  messagingSenderId: "573044136131",
  appId:             "1:573044136131:web:9164694157d5e0fedbaa76"
};
