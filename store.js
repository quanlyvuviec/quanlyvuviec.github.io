/**
 * ============================================================
 * QLVV STORE v2.0 — Zustand + React Query + Delta Sync
 * ============================================================
 * Thay đổi so với v1.0:
 *  [DELTA-1] DeltaSyncManager  — quản lý lastSyncTimestamp (localStorage)
 *  [DELTA-2] _firestoreDeltaLoad — truy vấn Firestore chỉ lấy bản ghi
 *              thay đổi sau lastSyncTimestamp (where + orderBy + limit 500)
 *  [DELTA-3] _idbUpsertCases   — Upsert (update-or-insert) vào IndexedDB
 *              thay vì ghi đè toàn bộ
 *  [DELTA-4] useCases          — sửa queryFn dùng Delta Sync, giữ
 *              Phase 1 (IDB instant) + Phase 2 (Firestore delta)
 *  [DELTA-5] useCaseStore      — thêm upsertCases() action
 *
 * Giữ nguyên:
 *  - Kiến trúc Hybrid Storage (IndexedDB làm cache chính)
 *  - Toàn bộ mutation hooks (useAddCase, useUpdateCase, useDeleteCase)
 *  - Virtual List components
 *  - Public API (window.AppStore, window.AppHooks, window.AppComponents)
 *
 * Yêu cầu Firestore Index (tạo 1 lần trong Firebase Console):
 *   Collection: cases
 *   Fields    : _updatedAt ASC   (single-field index — thường tự tạo)
 * ============================================================
 */

(function (global) {
  'use strict';

  // ── Chờ Zustand và ReactQuery sẵn sàng ──────────────────────────────────
  function waitReady(cb) {
    var tries = 0;
    function check() {
      tries++;
      if (
        global.zustand &&
        global.ReactQuery &&
        global.React &&
        tries < 200
      ) {
        cb();
      } else if (tries < 200) {
        setTimeout(check, 50);
      } else {
        console.error('[QLVV Store] Timeout: zustand/ReactQuery/React chưa sẵn sàng!');
      }
    }
    check();
  }

  // ══════════════════════════════════════════════════════════════════════
  //  [DELTA-1] DELTA SYNC MANAGER
  //  Quản lý mốc thời gian đồng bộ cuối cùng.
  //  Lưu vào localStorage với key riêng biệt theo projectId để tránh
  //  xung đột nếu nhiều project chạy trên cùng domain.
  // ══════════════════════════════════════════════════════════════════════
  var DeltaSyncManager = (function () {
    // Key localStorage — gắn projectId nếu có để tránh collision
    function _storageKey() {
      var pid = (
        global.__FIREBASE_CONFIG__ && global.__FIREBASE_CONFIG__.projectId
      ) || 'qlvv';
      return 'qlvv_last_sync_ts__' + pid;
    }

    return {
      /**
       * Lấy mốc đồng bộ cuối cùng.
       * @returns {string|null} ISO 8601 string hoặc null nếu chưa bao giờ sync.
       *
       * Trả về null → lần đầu sử dụng → queryFn sẽ thực hiện Full Load.
       */
      getLastSyncTimestamp: function () {
        try {
          return localStorage.getItem(_storageKey()) || null;
        } catch (e) {
          // localStorage bị block (private mode, quota) → fallback null
          console.warn('[DeltaSync] Không đọc được lastSyncTimestamp:', e.message);
          return null;
        }
      },

      /**
       * Lưu mốc đồng bộ sau khi sync thành công.
       * @param {string} isoString — ISO 8601 timestamp của bản ghi mới nhất vừa sync
       */
      setLastSyncTimestamp: function (isoString) {
        try {
          localStorage.setItem(_storageKey(), isoString);
        } catch (e) {
          console.warn('[DeltaSync] Không ghi được lastSyncTimestamp:', e.message);
        }
      },

      /**
       * Xóa mốc — buộc Full Load ở lần sync tiếp theo.
       * Dùng khi: đăng xuất, xóa dữ liệu, hoặc debug.
       */
      clearLastSyncTimestamp: function () {
        try {
          localStorage.removeItem(_storageKey());
        } catch (e) { /* silent */ }
      },
    };
  })();

  // ══════════════════════════════════════════════════════════════════════
  //  [DELTA-2] FIRESTORE DELTA LOAD
  //  Truy vấn Firestore chỉ lấy các bản ghi thay đổi SAU lastSyncTimestamp.
  //
  //  Chiến lược query:
  //    - Lần đầu (lastSyncTs = null)  → Full Load, không có WHERE
  //    - Các lần sau                  → WHERE _updatedAt > lastSyncTs
  //                                     ORDER BY _updatedAt ASC
  //                                     LIMIT 500 mỗi batch
  //
  //  Nếu kết quả = 500 (có thể còn nhiều hơn) → tự động fetch batch tiếp theo
  //  cho đến khi hết, đảm bảo không bỏ sót bản ghi nào.
  // ══════════════════════════════════════════════════════════════════════

  /** Số bản ghi tối đa mỗi batch Firestore — giữ ngưỡng an toàn */
  var DELTA_BATCH_SIZE = 500;

  /**
   * _firestoreDeltaLoad
   *
   * @param {object}      db           — firestoreDB instance (firebase.firestore())
   * @param {string|null} lastSyncTs   — ISO 8601 hoặc null (Full Load)
   * @returns {Promise<{ docs: object[], newestTimestamp: string|null, isFullLoad: boolean }>}
   *
   * `newestTimestamp` — _updatedAt của bản ghi MỚI NHẤT trong batch vừa tải.
   *   Caller sẽ dùng giá trị này để cập nhật lastSyncTimestamp sau khi upsert thành công.
   */
  async function _firestoreDeltaLoad(db, lastSyncTs) {
    var isFullLoad = (lastSyncTs === null);
    var allDocs = [];
    var newestTimestamp = lastSyncTs; // giữ nguyên nếu không có bản ghi mới
    var cursorTimestamp = lastSyncTs; // con trỏ phân trang theo _updatedAt

    console.info(
      isFullLoad
        ? '[DeltaSync] Full Load — chưa có lastSyncTimestamp'
        : '[DeltaSync] Delta Load — lấy bản ghi sau ' + lastSyncTs
    );

    // ── Vòng lặp phân trang: tiếp tục fetch cho đến khi < DELTA_BATCH_SIZE ──
    var batchIndex = 0;
    while (true) {
      batchIndex++;

      // Xây dựng query
      var query = db.collection('cases').orderBy('_updatedAt', 'asc');

      if (!isFullLoad && cursorTimestamp) {
        // [DELTA] Chỉ lấy bản ghi mới hơn con trỏ hiện tại
        query = query.where('_updatedAt', '>', cursorTimestamp);
      }

      query = query.limit(DELTA_BATCH_SIZE);

      var snapshot = await query.get();

      if (snapshot.empty) {
        // Không có bản ghi nào mới → thoát vòng lặp
        console.info('[DeltaSync] Batch #' + batchIndex + ': không có bản ghi mới.');
        break;
      }

      var batchDocs = snapshot.docs.map(function (d) { return d.data(); });
      allDocs = allDocs.concat(batchDocs);

      // Cập nhật con trỏ = _updatedAt của bản ghi cuối trong batch
      var lastDoc = batchDocs[batchDocs.length - 1];
      if (lastDoc && lastDoc._updatedAt) {
        cursorTimestamp = lastDoc._updatedAt;
        // Theo dõi timestamp mới nhất để lưu sau khi upsert thành công
        if (!newestTimestamp || cursorTimestamp > newestTimestamp) {
          newestTimestamp = cursorTimestamp;
        }
      }

      console.info(
        '[DeltaSync] Batch #' + batchIndex + ': ' + batchDocs.length + ' bản ghi' +
        (batchDocs.length === DELTA_BATCH_SIZE ? ' (có thể còn tiếp)' : ' (xong)')
      );

      // Nếu batch nhỏ hơn DELTA_BATCH_SIZE → đã hết dữ liệu, thoát
      if (batchDocs.length < DELTA_BATCH_SIZE) break;

      // Nếu không có _updatedAt trên bản ghi cuối → không thể phân trang, thoát
      if (!cursorTimestamp) {
        console.warn('[DeltaSync] Bản ghi thiếu _updatedAt — dừng phân trang.');
        break;
      }
    }

    console.info('[DeltaSync] Tổng cộng ' + allDocs.length + ' bản ghi delta.');

    return {
      docs: allDocs,
      newestTimestamp: newestTimestamp,
      isFullLoad: isFullLoad,
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  //  [DELTA-3] IDB UPSERT
  //  Hợp nhất delta vào IndexedDB theo cơ chế Upsert:
  //    - Nếu ID đã tồn tại → cập nhật (update)
  //    - Nếu ID chưa có   → thêm mới (insert)
  //
  //  Tuyệt đối KHÔNG xóa bản ghi cũ (xóa xử lý qua soft-delete hoặc
  //  onSnapshot riêng trong index-v2.html).
  //
  //  @param {object[]} deltaCases  — các bản ghi vừa tải từ Firestore
  //  @returns {Promise<object[]>}  — toàn bộ danh sách sau upsert
  // ══════════════════════════════════════════════════════════════════════
  async function _idbUpsertCases(deltaCases) {
    if (!deltaCases || deltaCases.length === 0) {
      // Không có gì mới — trả về dữ liệu IDB hiện tại
      return await global._idbLoadCases();
    }

    // Bước 1: Tải toàn bộ dữ liệu hiện có từ IndexedDB
    var localCases = [];
    try {
      localCases = (await global._idbLoadCases()) || [];
    } catch (e) {
      console.warn('[DeltaSync] Không tải được IDB, sẽ chỉ lưu delta:', e.message);
    }

    // Bước 2: Xây dựng Map<id, case> để Upsert O(1)
    var caseMap = Object.create(null);
    localCases.forEach(function (c) {
      if (c && c.id) caseMap[c.id] = c;
    });

    // Bước 3: Upsert từng bản ghi delta vào Map
    var insertCount = 0;
    var updateCount = 0;
    deltaCases.forEach(function (delta) {
      if (!delta || !delta.id) return; // bỏ qua bản ghi không hợp lệ
      if (caseMap[delta.id]) {
        // UPDATE: merge — ưu tiên dữ liệu cloud, giữ ảnh local nếu cloud không có
        var existing = caseMap[delta.id];
        caseMap[delta.id] = Object.assign({}, existing, delta, {
          // Bảo toàn ảnh cục bộ nếu cloud chưa có (ảnh lưu base64 trong IDB)
          photos: (delta.photos && delta.photos.length > 0)
            ? delta.photos
            : (existing.photos || []),
        });
        updateCount++;
      } else {
        // INSERT: thêm mới hoàn toàn
        caseMap[delta.id] = delta;
        insertCount++;
      }
    });

    console.info(
      '[DeltaSync] IDB Upsert: ' + insertCount + ' thêm mới, ' +
      updateCount + ' cập nhật, tổng ' + Object.keys(caseMap).length + ' bản ghi.'
    );

    // Bước 4: Chuyển Map về Array và lưu lại vào IndexedDB
    var merged = Object.keys(caseMap).map(function (id) { return caseMap[id]; });

    // Validate trước khi lưu (dùng hàm global nếu có)
    if (global.validateCases) {
      merged = global.validateCases(merged);
    }

    await global._idbSaveCases(merged);

    return merged;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  CHẠY SAU KHI THƯ VIỆN SẴN SÀNG
  // ══════════════════════════════════════════════════════════════════════
  waitReady(function () {
    var zustandCreate = global.zustand.create;

    // ══════════════════════════════════════════════════════════════
    //  ZUSTAND STORE
    // ══════════════════════════════════════════════════════════════

    /**
     * useCaseStore — Store trung tâm cho toàn bộ cases, lists, config
     *
     * API public:
     *  state.cases                         — danh sách tất cả vụ việc
     *  state.setCases(cases)               — set toàn bộ danh sách
     *  state.addCase(caseObj)              — thêm 1 vụ
     *  state.updateCase(id, partial)       — cập nhật từng phần (Partial Update)
     *  state.upsertCases(deltaCases)       — [DELTA-5] Upsert nhiều vụ việc
     *  state.removeCase(id)                — xóa vụ
     *  state.setCaseById(id, fullCase)     — replace toàn bộ 1 vụ
     *
     *  state.caseTypesList / setCaseTypesList
     *  state.assigneesList / setAssigneesList
     *  state.receivingUnitsList / setReceivingUnitsList
     *  state.handlingMethodsList / setHandlingMethodsList
     *
     *  state.syncStatus / setSyncStatus
     *  state.pendingConflicts / setPendingConflicts
     *  state.lastSyncTime / setLastSyncTime
     */
    var useCaseStore = zustandCreate(function (set, get) {
      return {
        // ── Cases ──────────────────────────────────────────────
        cases: [],

        setCases: function (cases) {
          set({ cases: Array.isArray(cases) ? cases : [] });
        },

        addCase: function (caseObj) {
          set(function (state) {
            var exists = state.cases.some(function (c) { return c.id === caseObj.id; });
            if (exists) return state;
            return { cases: state.cases.concat([caseObj]) };
          });
        },

        /**
         * Partial Update — chỉ cập nhật các trường thay đổi.
         * @param {string} id     — ID vụ việc
         * @param {object} patch  — object chứa các field cần cập nhật
         */
        updateCase: function (id, patch) {
          set(function (state) {
            var changed = false;
            var next = state.cases.map(function (c) {
              if (c.id !== id) return c;
              changed = true;
              return Object.assign({}, c, patch);
            });
            return changed ? { cases: next } : state;
          });
        },

        /**
         * [DELTA-5] upsertCases — Cập nhật store với delta từ Firestore.
         *
         * Thay vì setCases() (ghi đè toàn bộ), hàm này chỉ merge các bản
         * ghi thay đổi vào store hiện tại. Giữ nguyên các vụ việc cục bộ
         * chưa được đồng bộ.
         *
         * @param {object[]} deltaCases — các bản ghi vừa upsert vào IDB
         */
        upsertCases: function (deltaCases) {
          if (!deltaCases || deltaCases.length === 0) return;
          set(function (state) {
            // Xây dựng Map từ store hiện tại
            var map = Object.create(null);
            state.cases.forEach(function (c) { map[c.id] = c; });

            // Merge delta vào Map
            deltaCases.forEach(function (delta) {
              if (!delta || !delta.id) return;
              map[delta.id] = delta.photos === undefined && map[delta.id]
                ? Object.assign({}, map[delta.id], delta)
                : delta;
            });

            return { cases: Object.keys(map).map(function (id) { return map[id]; }) };
          });
        },

        removeCase: function (id) {
          set(function (state) {
            return { cases: state.cases.filter(function (c) { return c.id !== id; }) };
          });
        },

        setCaseById: function (id, fullCase) {
          set(function (state) {
            return {
              cases: state.cases.map(function (c) {
                return c.id === id ? fullCase : c;
              })
            };
          });
        },

        // ── Lists (cấu hình danh sách) ─────────────────────────
        caseTypesList: [],
        setCaseTypesList: function (list) { set({ caseTypesList: list }); },

        assigneesList: [],
        setAssigneesList: function (list) { set({ assigneesList: list }); },

        receivingUnitsList: [],
        setReceivingUnitsList: function (list) { set({ receivingUnitsList: list }); },

        handlingMethodsList: [],
        setHandlingMethodsList: function (list) { set({ handlingMethodsList: list }); },

        // ── Sync / Conflict ────────────────────────────────────
        syncStatus: 'local',
        setSyncStatus: function (status) {
          set(function (state) {
            var patch = { syncStatus: status };
            if (status === 'synced' || status === 'online') {
              patch.lastSyncTime = new Date();
            }
            return patch;
          });
        },

        lastSyncTime: null,
        setLastSyncTime: function (t) { set({ lastSyncTime: t }); },

        pendingConflicts: [],
        setPendingConflicts: function (conflicts) { set({ pendingConflicts: conflicts }); },
      };
    });

    // ══════════════════════════════════════════════════════════════
    //  REACT QUERY — QUERY CLIENT
    // ══════════════════════════════════════════════════════════════

    var QueryClient = global.ReactQuery.QueryClient;
    var queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          // Không tự động refetch khi focus tab (onSnapshot đã xử lý realtime)
          refetchOnWindowFocus: false,
          // Stale time 30s — phù hợp với dữ liệu thay đổi thường xuyên
          staleTime: 30 * 1000,
          retry: 2,
          retryDelay: function (n) { return Math.min(1000 * Math.pow(2, n), 30000); },
        },
        mutations: {
          retry: 1,
        },
      },
    });

    // ══════════════════════════════════════════════════════════════
    //  CUSTOM HOOKS — React Query wrappers
    // ══════════════════════════════════════════════════════════════

    var useQuery    = global.ReactQuery.useQuery;
    var useMutation = global.ReactQuery.useMutation;
    var useQueryClient = global.ReactQuery.useQueryClient;

    /**
     * useCases — Load cases theo chiến lược Delta Sync 2 pha.
     *
     * ┌─────────────────────────────────────────────────────────────┐
     * │  Phase 1: IndexedDB  (< 50ms)                               │
     * │    Trả dữ liệu cache ngay để UI render tức thì.             │
     * ├─────────────────────────────────────────────────────────────┤
     * │  Phase 2: Firestore Delta  (background)                     │
     * │    a. Đọc lastSyncTimestamp từ localStorage                  │
     * │    b. Null → Full Load  (lần đầu tiên)                      │
     * │       String → Delta Load (chỉ lấy bản ghi mới hơn ts)     │
     * │    c. Upsert delta vào IDB                                   │
     * │    d. Cập nhật lastSyncTimestamp = newest _updatedAt        │
     * │    e. upsertCases() vào Zustand store                       │
     * └─────────────────────────────────────────────────────────────┘
     *
     * Chi phí Firestore Read so sánh:
     *   Full Scan   : N reads mỗi lần mở app
     *   Delta Sync  : ~0 reads nếu không có thay đổi; chỉ đọc bản ghi MỚI
     */
    function useCases() {
      var setCases    = useCaseStore.getState().setCases;
      var upsertCases = useCaseStore.getState().upsertCases;
      var setSyncStatus = useCaseStore.getState().setSyncStatus;

      return useQuery({
        queryKey: ['cases'],
        queryFn: async function () {

          // ──────────────────────────────────────────────────────
          //  PHASE 1: IndexedDB — trả dữ liệu cache ngay
          // ──────────────────────────────────────────────────────
          var localCases = [];
          try {
            localCases = (await global._idbLoadCases()) || [];
          } catch (e) {
            console.warn('[useCases] IDB load lỗi:', e.message);
          }

          if (localCases.length > 0) {
            var validated = global.validateCases
              ? global.validateCases(localCases)
              : localCases;
            // Cập nhật store ngay — UI hiển thị dữ liệu local trước khi Firestore xong
            setCases(validated);
          }

          // ──────────────────────────────────────────────────────
          //  PHASE 2: Firestore Delta Sync (background)
          // ──────────────────────────────────────────────────────
          if (!global.firestoreDB) {
            // Không có kết nối Firestore → chỉ dùng local
            console.info('[useCases] Không có Firestore — dùng IndexedDB thuần.');
            return localCases;
          }

          try {
            setSyncStatus('syncing');

            // Bước 2a: Đọc mốc đồng bộ cuối cùng
            var lastSyncTs = DeltaSyncManager.getLastSyncTimestamp();

            // Bước 2b: Query Firestore — chỉ lấy bản ghi thay đổi sau lastSyncTs
            var deltaResult = await _firestoreDeltaLoad(global.firestoreDB, lastSyncTs);

            if (deltaResult.docs.length === 0 && !deltaResult.isFullLoad) {
              // Không có bản ghi nào mới → không tốn thêm 1 Read nào
              console.info('[useCases] Không có thay đổi kể từ ' + lastSyncTs);
              setSyncStatus('synced');
              return localCases; // trả về IDB cache đã có
            }

            // Bước 2c: Upsert delta vào IndexedDB
            var mergedCases = await _idbUpsertCases(deltaResult.docs);

            // Bước 2d: Lưu mốc thời gian của bản ghi mới nhất
            if (deltaResult.newestTimestamp) {
              DeltaSyncManager.setLastSyncTimestamp(deltaResult.newestTimestamp);
              console.info('[useCases] lastSyncTimestamp → ' + deltaResult.newestTimestamp);
            }

            // Bước 2e: Cập nhật Zustand store
            if (deltaResult.isFullLoad) {
              // Full Load lần đầu: set toàn bộ
              var validFull = global.validateCases
                ? global.validateCases(mergedCases)
                : mergedCases;
              setCases(validFull);
              setSyncStatus('synced');
              return validFull;
            } else {
              // Delta: chỉ upsert bản ghi thay đổi vào store, không làm mất bản ghi cũ
              var validDelta = global.validateCases
                ? global.validateCases(deltaResult.docs)
                : deltaResult.docs;
              upsertCases(validDelta);
              setSyncStatus('synced');
              return mergedCases; // trả về toàn bộ sau merge để React Query cache
            }

          } catch (e) {
            // Nếu Firestore lỗi (network, quota...) → vẫn trả về IDB cache
            console.warn('[useCases] Firestore delta sync lỗi, dùng local:', e.message);
            setSyncStatus('error');
            return localCases;
          }
        },

        // Giữ data cũ trong khi refetch — tránh flash loading
        keepPreviousData: true,
      });
    }

    /**
     * useAddCase — Mutation để thêm vụ việc mới.
     *
     * Đảm bảo gán _updatedAt khi thêm mới để Delta Sync hoạt động đúng.
     * Optimistic update: thêm vào store ngay, rollback nếu lỗi.
     */
    function useAddCase() {
      var qc = useQueryClient();

      return useMutation({
        mutationFn: async function (caseObj) {
          var currentCases = useCaseStore.getState().cases;

          // [DELTA] Đảm bảo _updatedAt luôn có giá trị — dùng để Delta Sync lọc
          var caseWithTs = Object.assign({}, caseObj, {
            _updatedAt: caseObj._updatedAt || new Date().toISOString(),
            _v: caseObj._v || 1,
            _deviceId: caseObj._deviceId || global._DEVICE_ID || 'unknown',
          });

          var newList = currentCases.concat([caseWithTs]);
          await global.saveCasesToDB(newList);

          if (global.writeAuditLog) {
            await global.writeAuditLog('ADD_CASE', { caseId: caseWithTs.id }).catch(function () {});
          }

          return caseWithTs;
        },

        onMutate: async function (caseObj) {
          await qc.cancelQueries({ queryKey: ['cases'] });
          var prev = useCaseStore.getState().cases.slice();
          useCaseStore.getState().addCase(caseObj);
          return { prev: prev };
        },

        onError: function (err, caseObj, ctx) {
          console.error('[useAddCase] Lỗi, rollback:', err);
          if (ctx && ctx.prev) useCaseStore.getState().setCases(ctx.prev);
        },

        onSettled: function () {
          qc.invalidateQueries({ queryKey: ['cases'] });
        },
      });
    }

    /**
     * useUpdateCase — Mutation để cập nhật từng phần (Partial Update).
     *
     * _updatedAt luôn được cập nhật → Delta Sync sẽ nhận ra bản ghi này
     * ở lần sync tiếp theo trên các thiết bị khác.
     *
     * @example
     *   const { mutate } = useUpdateCase();
     *   mutate({ id: 'VV001', patch: { status: 'hoàn thành' } });
     */
    function useUpdateCase() {
      var qc = useQueryClient();

      return useMutation({
        mutationFn: async function (_ref) {
          var id    = _ref.id;
          var patch = _ref.patch;

          var currentCases = useCaseStore.getState().cases;
          var updatedCases = currentCases.map(function (c) {
            if (c.id !== id) return c;
            return Object.assign({}, c, patch, {
              _v: (c._v || 0) + 1,
              // [DELTA] _updatedAt phải cập nhật → Firestore query dùng field này
              _updatedAt: new Date().toISOString(),
              _deviceId: global._DEVICE_ID || 'unknown',
            });
          });

          await global.saveCasesToDB(updatedCases);

          if (global.writeAuditLog && patch.status === 'hoàn thành') {
            await global.writeAuditLog('COMPLETE_CASE', { caseId: id }).catch(function () {});
          }

          return { id: id, patch: patch };
        },

        onMutate: async function (_ref2) {
          var id    = _ref2.id;
          var patch = _ref2.patch;
          await qc.cancelQueries({ queryKey: ['cases'] });
          var prev = useCaseStore.getState().cases.slice();
          useCaseStore.getState().updateCase(id, patch);
          return { prev: prev };
        },

        onError: function (err, vars, ctx) {
          console.error('[useUpdateCase] Lỗi, rollback:', err);
          if (ctx && ctx.prev) useCaseStore.getState().setCases(ctx.prev);
        },

        onSettled: function () {
          qc.invalidateQueries({ queryKey: ['cases'] });
        },
      });
    }

    /**
     * useDeleteCase — Soft Delete (Xóa mềm).
     *
     * Thay vì xóa hẳn document khỏi Firestore (khiến Delta Sync không thể
     * thông báo việc xóa sang các máy khác), mutation này gọi
     * softDeleteCaseInDB() để ghi { isDeleted: true, _updatedAt: now }.
     *
     * Kết quả: Khi máy B chạy Delta Sync, nó sẽ tải bản ghi đã có
     * isDeleted:true về và IndexedDB cục bộ cũng được cập nhật. UI
     * của máy B lọc ra (isDeleted !== true) nên bản ghi biến mất.
     *
     * Optimistic: đánh dấu isDeleted:true ngay, rollback bằng isDeleted:false.
     */
    function useDeleteCase() {
      var qc = useQueryClient();

      return useMutation({
        mutationFn: async function (caseId) {
          // [SOFT-DELETE] Gọi softDeleteCaseInDB thay vì deleteCaseFromDB
          await global.softDeleteCaseInDB(caseId);
          if (global.writeAuditLog) {
            await global.writeAuditLog('DELETE_CASE', { caseId: caseId }).catch(function () {});
          }
          return caseId;
        },

        // Optimistic: ẩn ngay khỏi UI bằng isDeleted — không xóa khỏi store
        onMutate: async function (caseId) {
          await qc.cancelQueries({ queryKey: ['cases'] });
          useCaseStore.getState().updateCase(caseId, {
            isDeleted: true,
            _updatedAt: new Date().toISOString(),
          });
          return { caseId: caseId };
        },

        // Rollback nhẹ: chỉ lật lại isDeleted — không cần setCases toàn bộ
        onError: function (err, caseId) {
          console.error('[useDeleteCase] Lỗi soft-delete, rollback isDeleted:', err);
          useCaseStore.getState().updateCase(caseId, { isDeleted: false });
        },

        onSettled: function () {
          qc.invalidateQueries({ queryKey: ['cases'] });
        },
      });
    }

    /**
     * useLists — Load caseTypesList, assigneesList, ... từ DB.
     * Không thay đổi so với v1.0 — lists ít thay đổi, không cần Delta Sync.
     */
    function useLists() {
      var store = useCaseStore.getState();

      return useQuery({
        queryKey: ['lists'],
        queryFn: async function () {
          var lists = await global.loadListsFromDB();
          if (lists) {
            store.setCaseTypesList(lists[0] || []);
            store.setAssigneesList(lists[1] || []);
            store.setReceivingUnitsList(lists[2] || []);
            store.setHandlingMethodsList(lists[3] || []);
          }
          return lists;
        },
        staleTime: 5 * 60 * 1000, // 5 phút
      });
    }

    // ══════════════════════════════════════════════════════════════
    //  VIRTUAL LIST HELPER (giữ nguyên từ v1.0)
    // ══════════════════════════════════════════════════════════════

    function VirtualCaseList(_ref3) {
      var items     = _ref3.items;
      var renderRow = _ref3.renderRow;
      var height    = _ref3.height || 500;

      if (!global.ReactVirtuoso || !global.ReactVirtuoso.Virtuoso) {
        return global.React.createElement(
          'tbody', null,
          items.map(function (item, idx) { return renderRow(item, idx); })
        );
      }

      var Virtuoso = global.ReactVirtuoso.Virtuoso;
      return global.React.createElement(
        'div',
        { style: { height: height + 'px', overflowY: 'auto' } },
        global.React.createElement(Virtuoso, {
          style: { height: height + 'px' },
          totalCount: items.length,
          itemContent: function (index) { return renderRow(items[index], index); },
          overscan: 200,
        })
      );
    }

    function VirtualTableBody(_ref4) {
      var items         = _ref4.items;
      var renderRow     = _ref4.renderRow;
      var renderHeader  = _ref4.renderHeader;
      var height        = _ref4.height || 500;
      var emptyMessage  = _ref4.emptyMessage || 'Không có dữ liệu';

      if (!global.ReactVirtuoso || !global.ReactVirtuoso.TableVirtuoso) {
        return global.React.createElement('div', null,
          renderHeader && renderHeader(),
          global.React.createElement('table', { className: 'data-table table-fixed' },
            global.React.createElement('tbody', null,
              items.length === 0
                ? global.React.createElement('tr', null,
                    global.React.createElement('td', { colSpan: 8, style: { textAlign: 'center', padding: '20px', color: '#94a3b8' } }, emptyMessage))
                : items.map(function (item, idx) { return renderRow(item, idx); })
            )
          )
        );
      }

      var TableVirtuoso = global.ReactVirtuoso.TableVirtuoso;
      if (items.length === 0) {
        return global.React.createElement('table', { className: 'data-table table-fixed' },
          renderHeader && renderHeader(),
          global.React.createElement('tbody', null,
            global.React.createElement('tr', null,
              global.React.createElement('td', { colSpan: 8, style: { textAlign: 'center', padding: '20px', color: '#94a3b8' } }, emptyMessage)
            )
          )
        );
      }

      return global.React.createElement(TableVirtuoso, {
        style: { height: height + 'px' },
        data: items,
        fixedHeaderContent: renderHeader || undefined,
        itemContent: function (index, item) { return renderRow(item, index); },
        overscan: 300,
        className: 'data-table table-fixed',
      });
    }

    // ══════════════════════════════════════════════════════════════
    //  EXPORT PUBLIC API
    // ══════════════════════════════════════════════════════════════

    global.AppStore = {
      useCaseStore:      useCaseStore,
      queryClient:       queryClient,
      // [DELTA] Expose DeltaSyncManager để UI có thể gọi clearLastSyncTimestamp()
      // khi cần force Full Sync (ví dụ: sau khi đăng xuất / đổi tài khoản)
      deltaSyncManager:  DeltaSyncManager,
    };

    global.AppHooks = {
      useCases:      useCases,
      useAddCase:    useAddCase,
      useUpdateCase: useUpdateCase,
      useDeleteCase: useDeleteCase,
      useLists:      useLists,
    };

    global.AppComponents = {
      VirtualCaseList:  VirtualCaseList,
      VirtualTableBody: VirtualTableBody,
    };

    console.info('[QLVV Store] ✅ v2.0 — Zustand + React Query + Delta Sync khởi tạo thành công!');
  });

})(window);
