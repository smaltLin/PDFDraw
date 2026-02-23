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
        tool: 'pen',         // 'pen' | 'eraser'
        color: '#1a1a2e',
        lineWidth: 2,
        isDrawing: false,
        // Per-page drawing data: { pageNum: { strokes: [...], redoStack: [...] } }
        pages: {},
        currentStroke: null,
        fileName: 'document',
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
            state.fileName = file.name.replace(/\.pdf$/i, '');

            els.welcomeScreen.style.display = 'none';
            els.canvasArea.style.display = 'flex';
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

        // Restore drawings
        redrawStrokes();
        updateUndoRedoState();
    }

    // ============ Drawing Engine ============
    function getPointerPos(e) {
        const rect = els.drawCanvas.getBoundingClientRect();
        const scaleX = els.drawCanvas.width / rect.width;
        const scaleY = els.drawCanvas.height / rect.height;

        if (e.touches && e.touches.length > 0) {
            return {
                x: (e.touches[0].clientX - rect.left) * scaleX,
                y: (e.touches[0].clientY - rect.top) * scaleY,
                pressure: e.touches[0].force || 0.5,
            };
        }
        return {
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top) * scaleY,
            pressure: e.pressure || 0.5,
        };
    }

    function startDrawing(e) {
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

        drawCtx.lineWidth = stroke.lineWidth;
        drawCtx.lineCap = 'round';
        drawCtx.lineJoin = 'round';

        // Draw only the last segment for performance
        const len = points.length;
        if (len >= 3) {
            drawCtx.beginPath();
            const p0 = points[len - 3];
            const p1 = points[len - 2];
            const p2 = points[len - 1];
            const midX1 = (p0.x + p1.x) / 2;
            const midY1 = (p0.y + p1.y) / 2;
            const midX2 = (p1.x + p2.x) / 2;
            const midY2 = (p1.y + p2.y) / 2;
            drawCtx.moveTo(midX1, midY1);
            drawCtx.quadraticCurveTo(p1.x, p1.y, midX2, midY2);
            drawCtx.stroke();
        } else {
            drawCtx.beginPath();
            drawCtx.moveTo(points[len - 2].x, points[len - 2].y);
            drawCtx.lineTo(points[len - 1].x, points[len - 1].y);
            drawCtx.stroke();
        }

        drawCtx.restore();
    }

    function stopDrawing(e) {
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

    function drawStroke(ctx, stroke) {
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

        ctx.lineWidth = stroke.lineWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);

        if (points.length === 2) {
            ctx.lineTo(points[1].x, points[1].y);
        } else {
            // Smooth curve using quadratic bezier
            for (let i = 1; i < points.length - 1; i++) {
                const midX = (points[i].x + points[i + 1].x) / 2;
                const midY = (points[i].y + points[i + 1].y) / 2;
                ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
            }
            // Last segment
            const last = points[points.length - 1];
            ctx.lineTo(last.x, last.y);
        }

        ctx.stroke();
        ctx.restore();
    }

    function redrawStrokes() {
        drawCtx.clearRect(0, 0, els.drawCanvas.width, els.drawCanvas.height);
        const pageData = getPageData(state.currentPage);
        pageData.strokes.forEach((stroke) => drawStroke(drawCtx, stroke));
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
        // Save all strokes as one undo-able action
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
            // Save current strokes relative positions
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

        // Draw white background
        mergeCtx.fillStyle = '#ffffff';
        mergeCtx.fillRect(0, 0, mergeCanvas.width, mergeCanvas.height);

        // Draw PDF layer
        mergeCtx.drawImage(els.pdfCanvas, 0, 0);
        // Draw annotations layer
        mergeCtx.drawImage(els.drawCanvas, 0, 0);

        // Download
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
            await renderPage(i);
            state.currentPage = i;
            redrawStrokes();

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

            // Small delay between downloads
            await new Promise((r) => setTimeout(r, 300));
        }

        // Restore original page
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
        els.drawCanvas.style.cursor = tool === 'eraser' ? 'cell' : 'crosshair';
    }

    function setColor(color) {
        state.color = color;
        $$('.color-btn').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.color === color);
        });
        // If user selects a color, switch to pen
        if (state.tool === 'eraser') setTool('pen');
    }

    function setLineWidth(width) {
        state.lineWidth = parseFloat(width);
        els.sizeSlider.value = width;
        $$('.size-btn').forEach((btn) => {
            btn.classList.toggle('active', parseFloat(btn.dataset.size) === parseFloat(width));
        });
    }

    // ============ Event Bindings ============
    function bindEvents() {
        // File Input
        els.btnOpen.addEventListener('click', () => els.fileInput.click());
        els.uploadBtn.addEventListener('click', () => els.fileInput.click());
        els.uploadArea.addEventListener('click', () => els.fileInput.click());

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

        // Also support drag & drop on the whole body for convenience
        document.body.addEventListener('dragover', (e) => e.preventDefault());
        document.body.addEventListener('drop', (e) => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file && file.type === 'application/pdf') loadPDF(file);
        });

        // Drawing events (mouse)
        els.drawCanvas.addEventListener('mousedown', startDrawing);
        els.drawCanvas.addEventListener('mousemove', draw);
        els.drawCanvas.addEventListener('mouseup', stopDrawing);
        els.drawCanvas.addEventListener('mouseleave', stopDrawing);

        // Drawing events (touch / stylus)
        els.drawCanvas.addEventListener('touchstart', startDrawing, { passive: false });
        els.drawCanvas.addEventListener('touchmove', draw, { passive: false });
        els.drawCanvas.addEventListener('touchend', stopDrawing);
        els.drawCanvas.addEventListener('touchcancel', stopDrawing);

        // Pointer events for pressure sensitivity
        els.drawCanvas.addEventListener('pointerdown', (e) => {
            // Capture pointer for reliable tracking
            els.drawCanvas.setPointerCapture(e.pointerId);
        });

        // Tool buttons
        els.btnPen.addEventListener('click', () => setTool('pen'));
        els.btnEraser.addEventListener('click', () => setTool('eraser'));

        // Color buttons
        $$('.color-btn').forEach((btn) => {
            btn.addEventListener('click', () => setColor(btn.dataset.color));
        });
        els.customColor.addEventListener('input', (e) => {
            setColor(e.target.value);
            // Deselect preset colors
            $$('.color-btn').forEach((b) => b.classList.remove('active'));
        });

        // Size buttons
        $$('.size-btn').forEach((btn) => {
            btn.addEventListener('click', () => setLineWidth(btn.dataset.size));
        });
        els.sizeSlider.addEventListener('input', (e) => {
            setLineWidth(e.target.value);
            // Deselect preset size buttons if not matching
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
            // Ctrl+O: Open file
            if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
                e.preventDefault();
                els.fileInput.click();
            }
            // Ctrl+Z: Undo
            if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                undo();
            }
            // Ctrl+Y or Ctrl+Shift+Z: Redo
            if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
                e.preventDefault();
                redo();
            }
            // P: Pen tool
            if (e.key === 'p' && !e.ctrlKey && !e.metaKey) setTool('pen');
            // E: Eraser tool
            if (e.key === 'e' && !e.ctrlKey && !e.metaKey) setTool('eraser');
            // Arrow keys for page navigation
            if (e.key === 'ArrowLeft' && !e.ctrlKey) goToPage(state.currentPage - 1);
            if (e.key === 'ArrowRight' && !e.ctrlKey) goToPage(state.currentPage + 1);
            // +/-: Zoom
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
    }

    init();
})();
