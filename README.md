# GrandCodex — front end · back end · database

Hasil pemisahan `GrandCodex (5).html` (satu berkas, data di `localStorage`) menjadi tiga bagian.

```
grandcodex/
├── frontend/            yang berjalan di browser
│   ├── index.html       kerangka halaman
│   ├── css/             tampilan, satu berkas per fitur: base.css (dasar & komponen bersama, dimuat pertama),
│   │                    tema, beranda, surat-tugas-personal, surat-tugas-kolektif, surat-tugas-daftar, pratinjau,
│   │                    rab, pok, rpd, tup, revisi, nomor-surat, honor, database, pengaturan
│   ├── js/app.js        aplikasi (hasil build dari src/, jangan disunting langsung)
│   ├── vendor/          JSZip, docx-preview, SheetJS (xlsx), pdf.js + worker
│   ├── src/*.ts         sumber TypeScript
│   └── package.json, tsconfig.json, build.mjs
├── backend/
│   └── server.js        API penyimpanan + penyaji berkas front end (Node, tanpa dependensi)
└── database/
    ├── schema.sql       skema SQLite: tabel master, output, pengaturan
    ├── seed/            data bawaan, dibagi per kategori
    │   ├── master/      pegawai.json, kampung.json, tarif.json, kode-klasifikasi.json, pok-<tahun>.json
    │   ├── output/      surat-tugas.json (data surat), rincian-biaya.json (rincian biaya tiap surat)
    │   └── template/    surat_tugas.docx, rincian_biaya.docx, permintaan_tup.docx
    └── grandcodex.db    basis data (dibuat otomatis saat server pertama kali jalan)
```

## Menjalankan

Butuh Node.js ≥ 22.13 (memakai `node:sqlite` bawaan; tidak perlu `npm install`).

```
cd backend
node server.js            # lalu buka http://127.0.0.1:3000
```

Pengaturan lewat variabel lingkungan: `PORT` (3000), `HOST` (`127.0.0.1`; `0.0.0.0` agar bisa dibuka
dari komputer lain di jaringan), `GC_DB` (lokasi berkas basis data).

## Login & hak akses

- Aplikasi dibuka lewat halaman login (`frontend/login.html`). Akun awal: **admin / admin** (role Admin) —
  dibuat otomatis saat tabel `users` masih kosong; segera ganti password-nya (ikon kunci di bilah samping).
- Tabel `users`: `username`, `password` (hash scrypt, bukan teks asli), `role` (`Admin` / `User`) dan
  `akses_fitur` (daftar kode menu yang boleh dibuka). Sesi login ada di tabel `sessions` (kuki `gc_sid`,
  berakhir setelah 12 jam tidak dipakai).
- Admin membuka semua menu dan mengelola akun di menu **Manajemen User** (tambah user, role, centang fitur,
  ganti password, hapus). User biasa hanya melihat menu yang dicentang untuknya; Beranda selalu ada.
- Lupa password admin satu-satunya: hentikan server, hapus barisnya (`DELETE FROM users;`), jalankan lagi —
  akun admin / admin dibuat ulang.

## Alur data

1. `index.html` memuat `api/seed.js` (data bawaan + template .docx dari `database/seed/`) dan
   `api/state.js` (seluruh isi basis data), baru kemudian `js/app.js`.
2. Aplikasi membaca data dari salinan di memori; setiap perubahan dikirim ke
   `PUT /api/kv/<kunci>` (atau `DELETE`) di latar belakang, dan diulang otomatis bila server tidak terjangkau.
3. Back end menyimpannya sebagai satu dokumen JSON per kunci, di tabel menurut kategorinya:
   `master` (data rujukan: pegawai, kampung, tarif, kode, POK, template), `output` (hasil kerja: surat tugas dan
   rincian biayanya — `st.records` dan `st.rincian` —, honor, nomor surat, RAB, RPD, TUP, revisi) dan `pengaturan` (sisanya). Daftar kunci ada di
   `database/schema.sql`; lihat semuanya dengan `SELECT * FROM semua`.
   Basis data lama (satu tabel `kv`) dipindahkan otomatis saat server dijalankan; salinan sebelum
   pemindahan disimpan sebagai `database/grandcodex.cadangan-sebelum-dibagi.db`.

Pengaturan tampilan (tema, huruf, bilah samping) tetap disimpan per-browser.

## Mengubah front end

```
cd frontend
npm install               # sekali saja: TypeScript + tipe pustaka
npm run build             # tsc (strict) → js/app.js
```

## Memindahkan data dari versi satu berkas

Data lama ada di `localStorage` browser dan tidak ikut pindah otomatis. Di berkas HTML lama pakai
**Unduh cadangan (.json)**, lalu pulihkan cadangan itu di versi ini.

## Batasan

- Hak akses fitur berlaku pada menu/tampilan. Di sisi server, semua data hanya bisa dibaca dan diubah oleh
  yang sudah login dan kelola user hanya oleh Admin, tetapi data tidak disaring per fitur: user yang login
  tetap menerima seluruh data aplikasi di browsernya.
- Sambungan memakai HTTP biasa; password dan kuki sesi tidak terenkripsi di jaringan. Jangan pakai
  `HOST=0.0.0.0` di jaringan yang tidak dipercaya tanpa HTTPS (mis. lewat reverse proxy).
- Bila dua orang menyunting kumpulan data yang sama bersamaan, simpanan terakhir yang menang
  (tiap kumpulan disimpan utuh, bukan per baris).
- Cadangan basis data: salin `database/grandcodex.db` saat server berhenti.
"# grandcodex" 
