# Aturan R8 tambahan untuk build rilis (minify dinyalakan otomatis oleh plugin Gradle Flutter).

# WorkManager (dipakai plugin, mis. Firebase/AdMob/Health) menyimpan antreannya di database Room.
# Room membuat implementasi database lewat refleksi (`WorkDatabase_Impl`); tanpa aturan ini R8 full mode
# membuang konstruktornya dan aplikasi crash sebelum Flutter jalan:
#   "Failed to create an instance of androidx.work.impl.WorkDatabase" (InitializationProvider).
-keep class * extends androidx.room.RoomDatabase { <init>(); }
-keep class androidx.work.impl.WorkDatabase_Impl { *; }
-keep class androidx.work.impl.** extends androidx.room.RoomDatabase { *; }
