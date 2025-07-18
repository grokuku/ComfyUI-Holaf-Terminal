/*
 * Copyright (C) 2025 Holaf
 * Holaf Utilities - Image Viewer Gallery Module
 *
 * MAJOR REFACTOR: This module now implements a high-performance virtualized scroller.
 * It calculates the total gallery height to create an accurate scrollbar,
 * but only ever renders the thumbnail elements that are currently visible in the viewport.
 * FIX: Flickering on scroll is eliminated by using differential DOM updates.
 * FIX: Scroll position is now preserved correctly during window resizes.
 */

import { imageViewerState } from "./image_viewer_state.js";
import { showFullscreenView } from './image_viewer_navigation.js';

// --- Configuration ---
const SCROLLBAR_DEBOUNCE_MS = 150; // Wait this long after scrollbar stops to load
const MAX_CONCURRENT_THUMBNAIL_LOADS = 12;

// --- Module-level state ---
let viewerInstance = null;
let galleryEl = null;
let gallerySizerEl = null;
let galleryGridEl = null;
let resizeObserver = null;
let renderedPlaceholders = new Map();
let scrollbarDebounceTimeout = null;

// NOUVELLE DISTINCTION: Drapeaux pour le type de défilement
let isWheelScrolling = false;
let wheelScrollTimeout = null;

// --- Loading Pipeline State ---
let activeThumbnailLoads = 0;

// --- Layout properties ---
let columnCount = 0;
let itemWidth = 0;
let itemHeight = 0;
let gap = 0;

/**
 * Initializes the gallery module and its observers.
 * @param {object} viewer - The main image viewer instance.
 */
export function initGallery(viewer) {
    viewerInstance = viewer;
    galleryEl = document.getElementById("holaf-viewer-gallery");

    document.addEventListener('holaf-refresh-thumbnail', (e) => {
        const { path_canon } = e.detail;
        if (path_canon) refreshThumbnailInGallery(path_canon);
    });

    galleryEl.innerHTML = `
        <div id="holaf-gallery-sizer" style="position: relative; width: 100%; height: 0; pointer-events: none;"></div>
        <div id="holaf-gallery-grid" style="position: absolute; top: 0; left: 0; width: 100%;"></div>
    `;
    gallerySizerEl = document.getElementById("holaf-gallery-sizer");
    galleryGridEl = document.getElementById("holaf-gallery-grid");

    resizeObserver = new ResizeObserver(entries => {
        if (entries.length > 0) handleResize();
    });
    resizeObserver.observe(galleryEl);
    
    // Étape 1 : Détecter la molette pour activer le drapeau
    galleryEl.addEventListener('wheel', () => {
        isWheelScrolling = true;
        clearTimeout(wheelScrollTimeout);
        wheelScrollTimeout = setTimeout(() => { isWheelScrolling = false; }, 300); // Le drapeau reste actif 300ms
    }, { passive: true });

    // Étape 2 : L'événement de scroll choisit la stratégie
    galleryEl.addEventListener('scroll', () => {
        renderVisibleItems();
        if (isWheelScrolling) {
            // CHARGEMENT IMMÉDIAT (pour la molette)
            loadVisibleThumbnails();
        } else {
            // CHARGEMENT DÉBRAYÉ (pour la barre de défilement)
            debouncedLoadVisibleThumbnails();
        }
    }, { passive: true });
}

/**
 * Main entry point to update the gallery. Called when filters change.
 */
export function syncGallery(viewer, images) {
    if (!galleryEl) initGallery(viewer);
    
    viewerInstance = viewer;
    const { images: allImages } = imageViewerState.getState();
    
    activeThumbnailLoads = 0;

    if (!allImages || allImages.length === 0) {
        galleryGridEl.innerHTML = '';
        renderedPlaceholders.clear();
        gallerySizerEl.style.height = '0px';
        viewerInstance.setLoadingState("No images match the current filters.");
        return;
    }

    const messageEl = galleryEl.querySelector('.holaf-viewer-message');
    if (messageEl) messageEl.remove();

    galleryEl.scrollTop = 0;
    updateLayout(true);
}

/**
 * Handles the gallery resize event.
 */
function handleResize() {
    const { images } = imageViewerState.getState();
    if (!images || images.length === 0 || !galleryEl) return;

    const oldItemHeightWithGap = itemHeight + gap;
    const oldColumnCount = columnCount;
    
    let topVisibleIndex = 0;
    if (oldItemHeightWithGap > 0 && oldColumnCount > 0) {
        const topRow = Math.floor(galleryEl.scrollTop / oldItemHeightWithGap);
        topVisibleIndex = topRow * oldColumnCount;
    }

    updateLayout(false);

    if (topVisibleIndex > 0 && columnCount > 0) {
        const newTopRow = Math.floor(topVisibleIndex / columnCount);
        const newScrollTop = newTopRow * (itemHeight + gap);
        galleryEl.scrollTop = newScrollTop;
    }

    renderVisibleItems(true);
}

/**
 * Recalculates grid layout properties.
 */
function updateLayout(renderAfter = true) {
    if (!galleryEl || !viewerInstance) return;
    
    const targetThumbSize = imageViewerState.getState().ui.thumbnail_size;
    const containerWidth = galleryEl.clientWidth;
    const style = window.getComputedStyle(galleryGridEl);
    gap = parseFloat(style.getPropertyValue('gap')) || 8;

    columnCount = Math.max(1, Math.floor((containerWidth + gap) / (targetThumbSize + gap)));
    const totalGapWidth = (columnCount - 1) * gap;
    itemWidth = (containerWidth - totalGapWidth) / columnCount;
    itemHeight = itemWidth;
    
    const { images } = imageViewerState.getState();
    const rowCount = Math.ceil(images.length / columnCount);
    const totalHeight = rowCount * (itemHeight + gap);
    gallerySizerEl.style.height = `${totalHeight}px`;

    if (renderAfter) {
        renderVisibleItems(true);
        loadVisibleThumbnails();
    }
}

/**
 * Renders only the visible items using a differential update.
 */
function renderVisibleItems() {
    requestAnimationFrame(() => {
        if (columnCount === 0) return;
        const { images, activeImage, selectedImages } = imageViewerState.getState();
        if (!images.length || !galleryEl || !galleryGridEl || itemHeight === 0) return;

        const viewportHeight = galleryEl.clientHeight;
        const scrollTop = galleryEl.scrollTop;
        
        const buffer = viewportHeight;
        const visibleAreaStart = Math.max(0, scrollTop - buffer);
        const visibleAreaEnd = scrollTop + viewportHeight + buffer;

        const itemHeightWithGap = itemHeight + gap;
        const startRow = Math.max(0, Math.floor(visibleAreaStart / itemHeightWithGap));
        const endRow = Math.ceil(visibleAreaEnd / itemHeightWithGap);

        const startIndex = startRow * columnCount;
        const endIndex = Math.min(images.length - 1, (endRow * columnCount) + columnCount - 1);
        
        const newPlaceholdersToRender = new Map();
        const fragment = document.createDocumentFragment();

        for (let i = startIndex; i <= endIndex; i++) {
            const image = images[i];
            if (!image) continue;

            const path = image.path_canon;
            let placeholder;

            if (renderedPlaceholders.has(path)) {
                placeholder = renderedPlaceholders.get(path);
                renderedPlaceholders.delete(path);
            } else {
                placeholder = createPlaceholder(viewerInstance, image, i);
                fragment.appendChild(placeholder);
            }
            
            const row = Math.floor(i / columnCount);
            const col = i % columnCount;
            const top = row * itemHeightWithGap;
            const left = col * (itemWidth + gap);
            placeholder.style.transform = `translate(${left}px, ${top}px)`;
            placeholder.style.width = `${itemWidth}px`;
            placeholder.style.height = `${itemHeight}px`;
            
            placeholder.classList.toggle('active', activeImage && activeImage.path_canon === path);
            const isSelected = [...selectedImages].some(selImg => selImg.path_canon === path);
            placeholder.querySelector('.holaf-viewer-thumb-checkbox').checked = isSelected;

            newPlaceholdersToRender.set(path, placeholder);
        }

        for (const element of renderedPlaceholders.values()) {
            element.remove();
        }

        if (fragment.childElementCount > 0) {
            galleryGridEl.appendChild(fragment);
        }
        
        renderedPlaceholders = newPlaceholdersToRender;
    });
}

/**
 * Stratégie de chargement DÉBRAYÉE pour la barre de défilement.
 */
function debouncedLoadVisibleThumbnails() {
    clearTimeout(scrollbarDebounceTimeout);
    scrollbarDebounceTimeout = setTimeout(loadVisibleThumbnails, SCROLLBAR_DEBOUNCE_MS);
}

/**
 * La fonction centrale qui déclenche le "gatekeeper".
 * Appelée directement par la molette, ou via le debounce par la barre de défilement.
 */
function loadVisibleThumbnails() {
    const placeholdersToLoad = Array.from(galleryGridEl.children);
    
    // Le "gatekeeper" est ici. Il est appelé à chaque fois mais se régule tout seul.
    const process = () => {
        if (activeThumbnailLoads >= MAX_CONCURRENT_THUMBNAIL_LOADS) {
            return;
        }

        const nextPlaceholder = placeholdersToLoad.find(p => !p.dataset.thumbnailLoadingOrLoaded);

        if (nextPlaceholder) {
            activeThumbnailLoads++;
            const imageIndex = parseInt(nextPlaceholder.dataset.index, 10);
            const image = imageViewerState.getState().images[imageIndex];
            if (image) {
                loadSpecificThumbnail(nextPlaceholder, image, false, () => {
                    activeThumbnailLoads--;
                    process(); // Une place s'est libérée, on continue.
                });
            } else {
                activeThumbnailLoads--;
                process();
            }
            process(); // On tente de remplir un autre slot immédiatement.
        }
    };

    for (let i = 0; i < MAX_CONCURRENT_THUMBNAIL_LOADS; i++) {
        process();
    }
}


/**
 * Loads the image for a single placeholder and calls a callback on completion.
 */
function loadSpecificThumbnail(placeholder, image, forceReload = false, onCompleteCallback = null) {
    if (placeholder.dataset.thumbnailLoadingOrLoaded === 'true' && !forceReload) {
        if (onCompleteCallback) onCompleteCallback();
        return;
    }
    
    placeholder.dataset.thumbnailLoadingOrLoaded = "true";

    placeholder.classList.remove('error');
    const existingError = placeholder.querySelector('.holaf-viewer-error-overlay');
    if (existingError) existingError.remove();
    
    const oldImg = placeholder.querySelector('img');
    if(oldImg && !forceReload) {
        if(onCompleteCallback) onCompleteCallback();
        return;
    }
    if(oldImg) oldImg.remove();
    
    const onComplete = () => {
        if (onCompleteCallback) onCompleteCallback();
    };

    const imageUrl = new URL(window.location.origin);
    imageUrl.pathname = '/holaf/images/thumbnail';
    const params = { filename: image.filename, subfolder: image.subfolder, mtime: image.mtime, t: forceReload ? new Date().getTime() : '' };
    imageUrl.search = new URLSearchParams(params);

    const img = document.createElement('img');
    img.src = imageUrl.href;
    img.alt = image.filename;
    img.loading = "lazy";
    img.className = "holaf-image-viewer-thumbnail";

    img.onload = () => {
        if (!placeholder.querySelector('.holaf-viewer-fullscreen-icon')) {
            const fsIcon = document.createElement('div');
            fsIcon.className = 'holaf-viewer-fullscreen-icon';
            fsIcon.innerHTML = '⛶';
            fsIcon.title = 'View fullscreen';
            fsIcon.addEventListener('click', (e) => {
                e.stopPropagation();
                showFullscreenView(viewerInstance, image);
            });
            placeholder.appendChild(fsIcon);
        }
        placeholder.prepend(img);
        onComplete();
    };
    img.onerror = () => {
        placeholder.classList.add('error');
        placeholder.dataset.thumbnailLoadingOrLoaded = "error";
        const errorDiv = document.createElement('div');
        errorDiv.className = 'holaf-viewer-error-overlay';
        errorDiv.textContent = 'Load Failed';
        placeholder.appendChild(errorDiv);
        onComplete();
    };
}


function createPlaceholder(viewer, image, index) {
    const placeholder = document.createElement('div');
    placeholder.className = 'holaf-viewer-thumbnail-placeholder';
    placeholder.style.position = 'absolute';
    placeholder.dataset.index = index;
    placeholder.dataset.pathCanon = image.path_canon;

    const editIcon = document.createElement('div');
    editIcon.className = 'holaf-viewer-edit-icon';
    editIcon.innerHTML = '✎';
    editIcon.title = "Edit image";
    editIcon.classList.toggle('active', image.has_edit_file);
    editIcon.onclick = (e) => {
        e.stopPropagation();
        viewer._showZoomedView(image);
    };
    placeholder.appendChild(editIcon);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'holaf-viewer-thumb-checkbox';
    checkbox.title = "Select image";
    placeholder.appendChild(checkbox);

    placeholder.addEventListener('click', (e) => {
        if (e.target.closest('.holaf-viewer-edit-icon, .holaf-viewer-fullscreen-icon')) return;
        const state = imageViewerState.getState();
        const clickedIndex = parseInt(e.currentTarget.dataset.index, 10);
        if (isNaN(clickedIndex)) return;
        const clickedImageData = state.images[clickedIndex];
        if (!clickedImageData) return;
        const anchorIndex = state.currentNavIndex > -1 ? state.currentNavIndex : clickedIndex;
        const selectedPaths = new Set([...state.selectedImages].map(img => img.path_canon));
        if (e.shiftKey) {
            if (!e.ctrlKey) selectedPaths.clear();
            const start = Math.min(anchorIndex, clickedIndex);
            const end = Math.max(anchorIndex, clickedIndex);
            for (let i = start; i <= end; i++) {
                if (state.images[i]) selectedPaths.add(state.images[i].path_canon);
            }
        } else if (e.ctrlKey || e.target.tagName === 'INPUT') {
            if (selectedPaths.has(clickedImageData.path_canon)) {
                selectedPaths.delete(clickedImageData.path_canon);
            } else {
                selectedPaths.add(clickedImageData.path_canon);
            }
        } else {
            selectedPaths.clear();
            selectedPaths.add(clickedImageData.path_canon);
        }
        const newSelectedImages = new Set(state.images.filter(img => selectedPaths.has(img.path_canon)));
        imageViewerState.setState({ selectedImages: newSelectedImages, activeImage: clickedImageData, currentNavIndex: clickedIndex });
        renderVisibleItems(true); 
        viewer._updateActionButtonsState();
    });

    placeholder.addEventListener('dblclick', (e) => {
        if (e.target.closest('.holaf-viewer-edit-icon, .holaf-viewer-fullscreen-icon, .holaf-viewer-thumb-checkbox')) return;
        viewer._showZoomedView(image);
    });

    return placeholder;
}

export function refreshThumbnailInGallery(path_canon) {
    const placeholder = renderedPlaceholders.get(path_canon);
    if (!placeholder) return;
    const allImages = imageViewerState.getState().images;
    const image = allImages.find(img => img.path_canon === path_canon);
    if (!image) return;

    const editIcon = placeholder.querySelector('.holaf-viewer-edit-icon');
    if (editIcon) editIcon.classList.add('active');
    
    loadSpecificThumbnail(placeholder, image, true);
}