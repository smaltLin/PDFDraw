/* ============================================
   PDF 繪圖作答工具 - Core Application Logic
   ============================================ */

(function () {
    'use strict';

    // ============ State ============
    const state = {
        pdfDoc: null,
        currentPage: 1,
        totalPages: 0,
        scale: 1.5,
        baseScale: 1,       // PDF viewport at scale=1 用來正規化座標
        tool: 'pen',         // 'pen' | 'eraser' | 'hand'
        color: '#1a1a2e',
        lineWidth: 2,
        isDrawing: false,
        isPanning: false,
        panStart: { x: 0, y: 0 },
        scrollStart: { x: 0, y: 0 },
        // Per-page drawing data: { pageNum: { strokes: [...], redoStack: [...] } }
        pages: {},
        currentStroke: null,
        fileName: 'document',
        // 多點觸控狀態
        multitouch: {
            active: false,
            initialDistance: 0,
            initialScale: 1,
            initialScroll: { x: 0, y: 0 },
            initialMidpoint: { x: 0, y: 0 },
        },
        _lastTouchEnd: 0,
    };

    // ============ DOM Elements ============
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const els = {
        fileInput: $('#file-input'),
        welcomeScreen: $('#welcome-screen'),
        uploadArea: $('#upload-area'),
        uploadBtn: $('#upload-btn'),
        canvasArea: $('#canvas-area'),
        canvasWrapper: $('#canvas-wrapper'),
        pdfCanvas: $('#pdf-canvas'),
        drawCanvas: $('#draw-canvas'),
        btnOpen: $('#btn-open'),
        btnPen: $('#btn-pen'),
        btnEraser: $('#btn-eraser'),
        btnHand: $('#btn-hand'),
        btnUndo: $('#btn-undo'),
        btnRedo: $('#btn-redo'),
        btnClear: $('#btn-clear'),
        btnExport: $('#btn-export'),
        btnExportAll: $('#btn-export-all'),
        btnPrev: $('#btn-prev'),
        btnNext: $('#btn-next'),
        pageInfo: $('#page-info'),
        sizeSlider: $('#size-slider'),
        customColor: $('#custom-color'),
        zoomControls: $('#zoom-controls'),
        btnZoomIn: $('#btn-zoom-in'),
        btnZoomOut: $('#btn-zoom-out'),
        btnZoomFit: $('#btn-zoom-fit'),
        zoomInfo: $('#zoom-info'),
        toastContainer: $('#toast-container'),
    };

    const pdfCtx = els.pdfCanvas.getContext('2d');
    const drawCtx = els.drawCanvas.getContext('2d');

    // ============ Utility ============
    function toast(message, type = 'info') {
        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.textContent = message;
        els.toastContainer.appendChild(el);
        setTimeout(() => el.remove(), 3000);
    }

    function getPageData(page) {
        if (!state.pages[page]) {
            state.pages[page] = { strokes: [], redoStack: [] };
        }
        return state.pages[page];
    }

    // ============ PDF Loading ============
    async function loadPDF(file) {
        try {
            const arrayBuffer = await file.arrayBuffer();
            state.pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
            state.totalPages = state.pdfDoc.numPages;
            state.currentPage = 1;
            state.pages = {}; // reset drawings
            state.fileName = file.name.replace(/\.pdf$/i, '');

            // 取得基準 viewport (scale=1) 用於正規化座標
            const firstPage = await state.pdfDoc.getPage(1);
            const baseViewport = firstPage.getViewport({ scale: 1 });
            state.baseScale = 1;

            els.welcomeScreen.style.display = 'none';
            els.canvasArea.classList.add('active');
            els.zoomControls.style.display = 'flex';

            await renderPage(state.currentPage);
            updatePageNav();
            toast(`已載入「${file.name}」，共 ${state.totalPages} 頁`, 'success');
        } catch (err) {
            console.error(err);
            toast('無法載入 PDF 檔案，請確認檔案格式正確', 'error');
        }
    }

    async function renderPage(pageNum) {
        if (!state.pdfDoc) return;

        const page = await state.pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: state.scale });

        // Set canvas dimensions
        els.pdfCanvas.width = viewport.width;
        els.pdfCanvas.height = viewport.height;
        els.drawCanvas.width = viewport.width;
        els.drawCanvas.height = viewport.height;

        // Render PDF
        pdfCtx.clearRect(0, 0, viewport.width, viewport.height);
        await page.render({ canvasContext: pdfCtx, viewport }).promise;

        // Restore drawings (strokes are stored in normalized coords, scale them)
        redrawStrokes();
        updateUndoRedoState();
    }

    // ============ Coordinate Normalization ============
    // 座標正規化：儲存時除以 scale，顯示時乘以 scale
    // 這樣筆跡會跟隨縮放正確顯示

    function screenToNormalized(x, y) {
        return {
            x: x / state.scale,
            y: y / state.scale,
        };
    }

    function normalizedToScreen(x, y) {
        return {
            x: x * state.scale,
            y: y * state.scale,
        };
    }

    // ============ Multi-touch Helpers ============
    function getTouchDistance(t1, t2) {
        const dx = t1.clientX - t2.clientX;
        const dy = t1.clientY - t2.clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function getTouchMidpoint(t1, t2) {
        return {
            x: (t1.clientX + t2.clientX) / 2,
            y: (t1.clientY + t2.clientY) / 2,
        };
    }

    // ============ Drawing Engine ============
    function getPointerPos(e) {
        const rect = els.drawCanvas.getBoundingClientRect();
        const scaleX = els.drawCanvas.width / rect.width;
        const scaleY = els.drawCanvas.height / rect.height;

        let clientX, clientY, pressure;
        if (e.touches && e.touches.length > 0) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
            pressure = e.touches[0].force || 0.5;
        } else {
            clientX = e.clientX;
            clientY = e.clientY;
            pressure = e.pressure || 0.5;
        }

        const canvasX = (clientX - rect.left) * scaleX;
        const canvasY = (clientY - rect.top) * scaleY;

        const normalized = screenToNormalized(canvasX, canvasY);
        return {
            x: normalized.x,
            y: normalized.y,
            pressure,
        };
    }

    function getPointerScreenPos(e) {
        if (e.touches && e.touches.length > 0) {
            return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
        return { x: e.clientX, y: e.clientY };
    }

    function startDrawing(e) {
        // Hand tool: 拖動模式
        if (state.tool === 'hand') {
            e.preventDefault();
            state.isPanning = true;
            const pos = getPointerScreenPos(e);
            state.panStart = { x: pos.x, y: pos.y };
            state.scrollStart = {
                x: els.canvasArea.scrollLeft,
                y: els.canvasArea.scrollTop,
            };
            return;
        }

        e.preventDefault();
        state.isDrawing = true;
        const pos = getPointerPos(e);

        state.currentStroke = {
            tool: state.tool,
            color: state.tool === 'eraser' ? 'eraser' : state.color,
            lineWidth: state.tool === 'eraser' ? state.lineWidth * 4 : state.lineWidth,
            points: [pos],
        };
    }

    function draw(e) {
        // Hand tool: 拖動
        if (state.tool === 'hand' && state.isPanning) {
            e.preventDefault();
            const pos = getPointerScreenPos(e);
            const dx = pos.x - state.panStart.x;
            const dy = pos.y - state.panStart.y;
            els.canvasArea.scrollLeft = state.scrollStart.x - dx;
            els.canvasArea.scrollTop = state.scrollStart.y - dy;
            return;
        }

        if (!state.isDrawing || !state.currentStroke) return;
        e.preventDefault();
        const pos = getPointerPos(e);
        state.currentStroke.points.push(pos);

        // Draw current stroke in real-time
        const stroke = state.currentStroke;
        const points = stroke.points;

        if (points.length < 2) return;

        drawCtx.save();

        if (stroke.tool === 'eraser') {
            drawCtx.globalCompositeOperation = 'destination-out';
            drawCtx.strokeStyle = 'rgba(0,0,0,1)';
        } else {
            drawCtx.globalCompositeOperation = 'source-over';
            drawCtx.strokeStyle = stroke.color;
        }

        // lineWidth 也要隨 scale 變化
        drawCtx.lineWidth = stroke.lineWidth * state.scale;
        drawCtx.lineCap = 'round';
        drawCtx.lineJoin = 'round';

        // Draw only the last segment for performance
        const len = points.length;
        if (len >= 3) {
            drawCtx.beginPath();
            const p0 = normalizedToScreen(points[len - 3].x, points[len - 3].y);
            const p1 = normalizedToScreen(points[len - 2].x, points[len - 2].y);
            const p2 = normalizedToScreen(points[len - 1].x, points[len - 1].y);
            const midX1 = (p0.x + p1.x) / 2;
            const midY1 = (p0.y + p1.y) / 2;
            const midX2 = (p1.x + p2.x) / 2;
            const midY2 = (p1.y + p2.y) / 2;
            drawCtx.moveTo(midX1, midY1);
            drawCtx.quadraticCurveTo(p1.x, p1.y, midX2, midY2);
            drawCtx.stroke();
        } else {
            drawCtx.beginPath();
            const a = normalizedToScreen(points[len - 2].x, points[len - 2].y);
            const b = normalizedToScreen(points[len - 1].x, points[len - 1].y);
            drawCtx.moveTo(a.x, a.y);
            drawCtx.lineTo(b.x, b.y);
            drawCtx.stroke();
        }

        drawCtx.restore();
    }

    function stopDrawing(e) {
        // Hand tool
        if (state.tool === 'hand') {
            state.isPanning = false;
            return;
        }

        if (!state.isDrawing || !state.currentStroke) return;
        e && e.preventDefault();
        state.isDrawing = false;

        if (state.currentStroke.points.length > 1) {
            const pageData = getPageData(state.currentPage);
            pageData.strokes.push(state.currentStroke);
            pageData.redoStack = []; // clear redo on new stroke
            updateUndoRedoState();
        }
        state.currentStroke = null;
    }

    function drawStroke(ctx, stroke, scale) {
        const points = stroke.points;
        if (points.length < 2) return;

        ctx.save();

        if (stroke.tool === 'eraser') {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.strokeStyle = 'rgba(0,0,0,1)';
        } else {
            ctx.globalCompositeOperation = 'source-over';
            ctx.strokeStyle = stroke.color;
        }

        // lineWidth 乘以 scale，讓粗細跟隨縮放
        ctx.lineWidth = stroke.lineWidth * scale;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // 將正規化座標轉換為螢幕座標
        const screenPoints = points.map((p) => normalizedToScreen(p.x, p.y));

        ctx.beginPath();
        ctx.moveTo(screenPoints[0].x, screenPoints[0].y);

        if (screenPoints.length === 2) {
            ctx.lineTo(screenPoints[1].x, screenPoints[1].y);
        } else {
            for (let i = 1; i < screenPoints.length - 1; i++) {
                const midX = (screenPoints[i].x + screenPoints[i + 1].x) / 2;
                const midY = (screenPoints[i].y + screenPoints[i + 1].y) / 2;
                ctx.quadraticCurveTo(screenPoints[i].x, screenPoints[i].y, midX, midY);
            }
            const last = screenPoints[screenPoints.length - 1];
            ctx.lineTo(last.x, last.y);
        }

        ctx.stroke();
        ctx.restore();
    }

    function redrawStrokes() {
        drawCtx.clearRect(0, 0, els.drawCanvas.width, els.drawCanvas.height);
        const pageData = getPageData(state.currentPage);
        pageData.strokes.forEach((stroke) => drawStroke(drawCtx, stroke, state.scale));
    }

    // ============ Undo / Redo ============
    function undo() {
        const pageData = getPageData(state.currentPage);
        if (pageData.strokes.length === 0) return;
        const stroke = pageData.strokes.pop();
        pageData.redoStack.push(stroke);
        redrawStrokes();
        updateUndoRedoState();
    }

    function redo() {
        const pageData = getPageData(state.currentPage);
        if (pageData.redoStack.length === 0) return;
        const stroke = pageData.redoStack.pop();
        pageData.strokes.push(stroke);
        redrawStrokes();
        updateUndoRedoState();
    }

    function clearPage() {
        const pageData = getPageData(state.currentPage);
        if (pageData.strokes.length === 0) return;
        pageData.redoStack.push(...pageData.strokes.reverse());
        pageData.strokes = [];
        redrawStrokes();
        updateUndoRedoState();
        toast('已清除本頁繪圖', 'info');
    }

    function updateUndoRedoState() {
        const pageData = getPageData(state.currentPage);
        els.btnUndo.disabled = pageData.strokes.length === 0;
        els.btnRedo.disabled = pageData.redoStack.length === 0;
    }

    // ============ Page Navigation ============
    async function goToPage(pageNum) {
        if (pageNum < 1 || pageNum > state.totalPages) return;
        state.currentPage = pageNum;
        await renderPage(pageNum);
        updatePageNav();
    }

    function updatePageNav() {
        els.pageInfo.textContent = `${state.currentPage} / ${state.totalPages}`;
        els.btnPrev.disabled = state.currentPage <= 1;
        els.btnNext.disabled = state.currentPage >= state.totalPages;
    }

    // ============ Zoom ============
    async function setZoom(newScale) {
        state.scale = Math.max(0.5, Math.min(4, newScale));
        els.zoomInfo.textContent = `${Math.round(state.scale * 100)}%`;

        if (state.pdfDoc) {
            await renderPage(state.currentPage);
        }
    }

    async function fitWidth() {
        if (!state.pdfDoc) return;
        const page = await state.pdfDoc.getPage(state.currentPage);
        const viewport = page.getViewport({ scale: 1 });
        const containerWidth = els.canvasArea.clientWidth - 40;
        const newScale = containerWidth / viewport.width;
        await setZoom(newScale);
    }

    // ============ Export ============
    function exportCurrentPage() {
        if (!state.pdfDoc) {
            toast('請先載入 PDF 檔案', 'error');
            return;
        }

        const mergeCanvas = document.createElement('canvas');
        mergeCanvas.width = els.pdfCanvas.width;
        mergeCanvas.height = els.pdfCanvas.height;
        const mergeCtx = mergeCanvas.getContext('2d');

        mergeCtx.fillStyle = '#ffffff';
        mergeCtx.fillRect(0, 0, mergeCanvas.width, mergeCanvas.height);
        mergeCtx.drawImage(els.pdfCanvas, 0, 0);
        mergeCtx.drawImage(els.drawCanvas, 0, 0);

        const link = document.createElement('a');
        link.download = `${state.fileName}_p${state.currentPage}.jpg`;
        link.href = mergeCanvas.toDataURL('image/jpeg', 0.92);
        link.click();

        toast(`已匯出第 ${state.currentPage} 頁`, 'success');
    }

    async function exportAllPages() {
        if (!state.pdfDoc) {
            toast('請先載入 PDF 檔案', 'error');
            return;
        }

        toast('正在匯出所有頁面...', 'info');
        const savedPage = state.currentPage;

        for (let i = 1; i <= state.totalPages; i++) {
            state.currentPage = i;
            await renderPage(i);

            const mergeCanvas = document.createElement('canvas');
            mergeCanvas.width = els.pdfCanvas.width;
            mergeCanvas.height = els.pdfCanvas.height;
            const mergeCtx = mergeCanvas.getContext('2d');

            mergeCtx.fillStyle = '#ffffff';
            mergeCtx.fillRect(0, 0, mergeCanvas.width, mergeCanvas.height);
            mergeCtx.drawImage(els.pdfCanvas, 0, 0);
            mergeCtx.drawImage(els.drawCanvas, 0, 0);

            const link = document.createElement('a');
            link.download = `${state.fileName}_p${i}.jpg`;
            link.href = mergeCanvas.toDataURL('image/jpeg', 0.92);
            link.click();

            await new Promise((r) => setTimeout(r, 300));
        }

        state.currentPage = savedPage;
        await renderPage(savedPage);
        updatePageNav();

        toast(`已匯出所有 ${state.totalPages} 頁`, 'success');
    }

    // ============ Tool Selection ============
    function setTool(tool) {
        state.tool = tool;
        els.btnPen.classList.toggle('active', tool === 'pen');
        els.btnEraser.classList.toggle('active', tool === 'eraser');
        els.btnHand.classList.toggle('active', tool === 'hand');

        if (tool === 'hand') {
            els.drawCanvas.style.cursor = 'grab';
            els.drawCanvas.style.pointerEvents = 'auto';
        } else if (tool === 'eraser') {
            els.drawCanvas.style.cursor = 'cell';
        } else {
            els.drawCanvas.style.cursor = 'crosshair';
        }
    }

    function setColor(color) {
        state.color = color;
        $$('.color-btn').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.color === color);
        });
        if (state.tool !== 'pen') setTool('pen');
    }

    function setLineWidth(width) {
        state.lineWidth = parseFloat(width);
        els.sizeSlider.value = width;
        $$('.size-btn').forEach((btn) => {
            btn.classList.toggle('active', parseFloat(btn.dataset.size) === parseFloat(width));
        });
    }

    // ============ File Open Helper ============
    function openFileDialog() {
        // 重設 value 避免選同一檔案不觸發 change 事件
        els.fileInput.value = '';
        els.fileInput.click();
    }

    // ============ Event Bindings ============
    function bindEvents() {
        // File Input — 修復重複觸發問題
        els.btnOpen.addEventListener('click', (e) => {
            e.stopPropagation();
            openFileDialog();
        });

        els.uploadBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // 防止冒泡到 uploadArea 再次觸發
            openFileDialog();
        });

        els.uploadArea.addEventListener('click', (e) => {
            // 只在直接點擊 uploadArea 時觸發，而非其子元素冒泡
            if (e.target === els.uploadArea || e.target.closest('.upload-area') === els.uploadArea) {
                // 若是從 uploadBtn 冒泡上來的，不再處理
                if (e.target === els.uploadBtn || e.target.closest('#upload-btn')) return;
                openFileDialog();
            }
        });

        els.fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) loadPDF(e.target.files[0]);
        });

        // Drag & Drop
        els.uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            els.uploadArea.classList.add('drag-over');
        });
        els.uploadArea.addEventListener('dragleave', () => {
            els.uploadArea.classList.remove('drag-over');
        });
        els.uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            els.uploadArea.classList.remove('drag-over');
            const file = e.dataTransfer.files[0];
            if (file && file.type === 'application/pdf') {
                loadPDF(file);
            } else {
                toast('請選擇 PDF 格式的檔案', 'error');
            }
        });

        document.body.addEventListener('dragover', (e) => e.preventDefault());
        document.body.addEventListener('drop', (e) => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file && file.type === 'application/pdf') loadPDF(file);
        });

        // ======== Pointer Events（統一處理滑鼠 + 觸控筆 + 單指觸控繪圖） ========
        els.drawCanvas.addEventListener('pointerdown', (e) => {
            // 多點觸控進行中時，忽略新的 pointer 事件
            if (state.multitouch.active) return;
            // 觸控的 pointerdown：只有單指才處理（雙指由 touch events 處理）
            if (e.pointerType === 'touch') {
                // 不要 capture touch pointer，以免影響多指偵測
            } else {
                els.drawCanvas.setPointerCapture(e.pointerId);
            }
            if (state.tool === 'hand') els.drawCanvas.style.cursor = 'grabbing';
            startDrawing(e);
        });

        els.drawCanvas.addEventListener('pointermove', (e) => {
            if (state.multitouch.active) return;
            draw(e);
        });

        els.drawCanvas.addEventListener('pointerup', (e) => {
            if (state.multitouch.active) return;
            if (state.tool === 'hand') els.drawCanvas.style.cursor = 'grab';
            stopDrawing(e);
        });

        els.drawCanvas.addEventListener('pointerleave', (e) => {
            if (state.multitouch.active) return;
            if (e.pointerType !== 'touch') {
                if (state.tool === 'hand') els.drawCanvas.style.cursor = 'grab';
                stopDrawing(e);
            }
        });

        els.drawCanvas.addEventListener('pointercancel', (e) => {
            if (state.tool === 'hand') els.drawCanvas.style.cursor = 'grab';
            stopDrawing(e);
        });

        // ======== Touch Events（專門處理雙指縮放/拖曳） ========
        // 在 document 層級攔截，確保最優先
        document.addEventListener('touchstart', (e) => {
            if (e.touches.length >= 2) {
                e.preventDefault();
                // 如果正在繪圖，中斷目前筆跡
                if (state.isDrawing && state.currentStroke) {
                    state.isDrawing = false;
                    state.currentStroke = null;
                    redrawStrokes();
                }
                const t1 = e.touches[0], t2 = e.touches[1];
                state.multitouch.active = true;
                state.multitouch.initialDistance = getTouchDistance(t1, t2);
                state.multitouch.initialScale = state.scale;
                state.multitouch.initialMidpoint = getTouchMidpoint(t1, t2);
                state.multitouch.initialScroll = {
                    x: els.canvasArea.scrollLeft,
                    y: els.canvasArea.scrollTop,
                };
            }
        }, { passive: false });

        document.addEventListener('touchmove', (e) => {
            if (state.multitouch.active && e.touches.length >= 2) {
                e.preventDefault();
                const t1 = e.touches[0], t2 = e.touches[1];

                // 計算縮放
                const currentDist = getTouchDistance(t1, t2);
                const ratio = currentDist / state.multitouch.initialDistance;
                const newScale = Math.max(0.5, Math.min(4, state.multitouch.initialScale * ratio));

                // 計算拖曳偏移
                const currentMid = getTouchMidpoint(t1, t2);
                const dx = currentMid.x - state.multitouch.initialMidpoint.x;
                const dy = currentMid.y - state.multitouch.initialMidpoint.y;

                if (Math.abs(newScale - state.scale) > 0.01) {
                    state.scale = newScale;
                    els.zoomInfo.textContent = `${Math.round(state.scale * 100)}%`;
                }

                els.canvasArea.scrollLeft = state.multitouch.initialScroll.x - dx;
                els.canvasArea.scrollTop = state.multitouch.initialScroll.y - dy;
            } else if (state.multitouch.active) {
                e.preventDefault(); // 多點觸控中只剩一指，繼續攔截
            }
        }, { passive: false });

        document.addEventListener('touchend', async (e) => {
            if (state.multitouch.active) {
                if (e.touches.length === 0) {
                    state.multitouch.active = false;
                    if (state.pdfDoc) {
                        await renderPage(state.currentPage);
                    }
                }
                e.preventDefault();
                return;
            }
            // 防止雙擊縮放
            const now = Date.now();
            if (now - state._lastTouchEnd <= 300) {
                e.preventDefault();
            }
            state._lastTouchEnd = now;
        }, { passive: false });

        document.addEventListener('touchcancel', () => {
            state.multitouch.active = false;
        });

        // 防止 Safari 的 gesture events
        document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
        document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
        document.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });

        // Tool buttons
        els.btnPen.addEventListener('click', () => setTool('pen'));
        els.btnEraser.addEventListener('click', () => setTool('eraser'));
        els.btnHand.addEventListener('click', () => setTool('hand'));

        // Color buttons
        $$('.color-btn').forEach((btn) => {
            btn.addEventListener('click', () => setColor(btn.dataset.color));
        });
        els.customColor.addEventListener('input', (e) => {
            setColor(e.target.value);
            $$('.color-btn').forEach((b) => b.classList.remove('active'));
        });

        // Size buttons
        $$('.size-btn').forEach((btn) => {
            btn.addEventListener('click', () => setLineWidth(btn.dataset.size));
        });
        els.sizeSlider.addEventListener('input', (e) => {
            setLineWidth(e.target.value);
            $$('.size-btn').forEach((btn) => {
                btn.classList.toggle('active', parseFloat(btn.dataset.size) === parseFloat(e.target.value));
            });
        });

        // Undo / Redo / Clear
        els.btnUndo.addEventListener('click', undo);
        els.btnRedo.addEventListener('click', redo);
        els.btnClear.addEventListener('click', clearPage);

        // Export
        els.btnExport.addEventListener('click', exportCurrentPage);
        els.btnExportAll.addEventListener('click', exportAllPages);

        // Page navigation
        els.btnPrev.addEventListener('click', () => goToPage(state.currentPage - 1));
        els.btnNext.addEventListener('click', () => goToPage(state.currentPage + 1));

        // Zoom
        els.btnZoomIn.addEventListener('click', () => setZoom(state.scale + 0.25));
        els.btnZoomOut.addEventListener('click', () => setZoom(state.scale - 0.25));
        els.btnZoomFit.addEventListener('click', fitWidth);

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
                e.preventDefault();
                openFileDialog();
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                undo();
            }
            if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
                e.preventDefault();
                redo();
            }
            if (e.key === 'p' && !e.ctrlKey && !e.metaKey) setTool('pen');
            if (e.key === 'e' && !e.ctrlKey && !e.metaKey) setTool('eraser');
            if (e.key === 'h' && !e.ctrlKey && !e.metaKey) setTool('hand');
            if (e.key === 'ArrowLeft' && !e.ctrlKey) goToPage(state.currentPage - 1);
            if (e.key === 'ArrowRight' && !e.ctrlKey) goToPage(state.currentPage + 1);
            if (e.key === '+' || e.key === '=') setZoom(state.scale + 0.25);
            if (e.key === '-') setZoom(state.scale - 0.25);
        });

        // Ctrl+scroll for zoom
        els.canvasArea.addEventListener('wheel', (e) => {
            if (e.ctrlKey) {
                e.preventDefault();
                const delta = e.deltaY > 0 ? -0.1 : 0.1;
                setZoom(state.scale + delta);
            }
        }, { passive: false });

        // Window resize
        window.addEventListener('resize', () => {
            if (state.pdfDoc) renderPage(state.currentPage);
        });
    }

    // ============ Init ============
    function init() {
        bindEvents();
        els.zoomInfo.textContent = `${Math.round(state.scale * 100)}%`;

        // 自動設定版本號 (根據文件最後修改日期+時間)
        const d = new Date(document.lastModified);
        const pad = (n) => String(n).padStart(2, '0');
        const ver = `v${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}.${pad(d.getHours())}${pad(d.getMinutes())}`;
        const versionEl = document.getElementById('version-label');
        if (versionEl) versionEl.textContent = ver;
    }

    init();
})();
