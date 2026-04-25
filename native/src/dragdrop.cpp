#include <napi.h>
#include <windows.h>
#include <shlobj.h>
#include <vector>
#include <string>
#include <iostream>

#pragma comment(lib, "Ole32.lib")
#pragma comment(lib, "Shell32.lib")

std::vector<std::wstring> GetFilePathsFromDataObject(IDataObject* pDataObj) {
    std::vector<std::wstring> files;
    FORMATETC fmt = { CF_HDROP, NULL, DVASPECT_CONTENT, -1, TYMED_HGLOBAL };
    STGMEDIUM stg;
    
    if (SUCCEEDED(pDataObj->GetData(&fmt, &stg))) {
        HDROP hDrop = (HDROP)GlobalLock(stg.hGlobal);
        if (hDrop) {
            UINT count = DragQueryFileW(hDrop, 0xFFFFFFFF, NULL, 0);
            for (UINT i = 0; i < count; i++) {
                wchar_t path[MAX_PATH];
                if (DragQueryFileW(hDrop, i, path, MAX_PATH)) {
                    files.push_back(path);
                }
            }
            GlobalUnlock(stg.hGlobal);
        }
        ReleaseStgMedium(&stg);
    }
    return files;
}

class SimpleDropSource : public IDropSource {
    ULONG m_ref;
public:
    SimpleDropSource() : m_ref(1) {}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) {
        if (riid == IID_IUnknown || riid == IID_IDropSource) { *ppv = static_cast<IDropSource*>(this); AddRef(); return S_OK; }
        *ppv = NULL; return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() { return InterlockedIncrement(&m_ref); }
    ULONG STDMETHODCALLTYPE Release() {
        ULONG ref = InterlockedDecrement(&m_ref);
        if (ref == 0) delete this;
        return ref;
    }
    HRESULT STDMETHODCALLTYPE QueryContinueDrag(BOOL fEscapePressed, DWORD grfKeyState) {
        if (fEscapePressed) return DRAGDROP_S_CANCEL;
        if (!(grfKeyState & MK_LBUTTON)) return DRAGDROP_S_DROP;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GiveFeedback(DWORD dwEffect) {
        return DRAGDROP_S_USEDEFAULTCURSORS;
    }
};

class SimpleDataObject : public IDataObject {
    ULONG m_ref;
    std::vector<std::wstring> m_files;
public:
    SimpleDataObject(const std::vector<std::wstring>& files) : m_ref(1), m_files(files) {}
    
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) {
        if (riid == IID_IUnknown || riid == IID_IDataObject) { *ppv = static_cast<IDataObject*>(this); AddRef(); return S_OK; }
        *ppv = NULL; return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() { return InterlockedIncrement(&m_ref); }
    ULONG STDMETHODCALLTYPE Release() {
        ULONG ref = InterlockedDecrement(&m_ref);
        if (ref == 0) delete this;
        return ref;
    }
    
    HRESULT STDMETHODCALLTYPE GetData(FORMATETC* pformatetcIn, STGMEDIUM* pmedium) {
        if (!(pformatetcIn->tymed & TYMED_HGLOBAL)) return DV_E_TYMED;
        if (pformatetcIn->cfFormat != CF_HDROP) return DV_E_FORMATETC;
        
        size_t size = sizeof(DROPFILES);
        for (const auto& file : m_files) {
            size += (file.length() + 1) * sizeof(wchar_t);
        }
        size += sizeof(wchar_t); // double null terminator
        
        HGLOBAL hMem = GlobalAlloc(GHND, size);
        if (!hMem) return E_OUTOFMEMORY;
        
        DROPFILES* df = (DROPFILES*)GlobalLock(hMem);
        df->pFiles = sizeof(DROPFILES);
        df->fWide = TRUE;
        
        wchar_t* ptr = (wchar_t*)((char*)df + sizeof(DROPFILES));
        for (const auto& file : m_files) {
            wcscpy(ptr, file.c_str());
            ptr += file.length() + 1;
        }
        *ptr = L'\0';
        
        GlobalUnlock(hMem);
        
        pmedium->tymed = TYMED_HGLOBAL;
        pmedium->hGlobal = hMem;
        pmedium->pUnkForRelease = NULL;
        return S_OK;
    }
    
    HRESULT STDMETHODCALLTYPE GetDataHere(FORMATETC*, STGMEDIUM*) { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE QueryGetData(FORMATETC* pformatetc) {
        if (pformatetc->cfFormat == CF_HDROP && (pformatetc->tymed & TYMED_HGLOBAL)) return S_OK;
        return DV_E_FORMATETC;
    }
    HRESULT STDMETHODCALLTYPE GetCanonicalFormatEtc(FORMATETC*, FORMATETC*) { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE SetData(FORMATETC*, STGMEDIUM*, BOOL) { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE EnumFormatEtc(DWORD, IEnumFORMATETC**) { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE DAdvise(FORMATETC*, DWORD, IAdviseSink*, DWORD*) { return OLE_E_ADVISENOTSUPPORTED; }
    HRESULT STDMETHODCALLTYPE DUnadvise(DWORD) { return OLE_E_ADVISENOTSUPPORTED; }
    HRESULT STDMETHODCALLTYPE EnumDAdvise(IEnumSTATDATA**) { return OLE_E_ADVISENOTSUPPORTED; }
};

class DragDropWorker : public Napi::AsyncWorker {
    std::vector<std::wstring> m_files;
public:
    DragDropWorker(Napi::Function& callback, std::vector<std::wstring> files)
        : Napi::AsyncWorker(callback), m_files(files) {}
        
    void Execute() override {
        OleInitialize(NULL);
        IDataObject* pDataObj = new SimpleDataObject(m_files);
        IDropSource* pDropSrc = new SimpleDropSource();
        DWORD dwEffect;
        DoDragDrop(pDataObj, pDropSrc, DROPEFFECT_COPY, &dwEffect);
        pDataObj->Release();
        pDropSrc->Release();
        OleUninitialize();
    }
    void OnOK() override {
        Napi::HandleScope scope(Env());
        Callback().Call({Env().Null()});
    }
};

class EdgeDropTarget : public IDropTarget {
    ULONG m_ref;
    Napi::ThreadSafeFunction m_tsfn;

public:
    EdgeDropTarget(Napi::ThreadSafeFunction tsfn) : m_ref(1), m_tsfn(tsfn) {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) {
        if (riid == IID_IUnknown || riid == IID_IDropTarget) {
            *ppv = static_cast<IDropTarget*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = NULL;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() { return InterlockedIncrement(&m_ref); }
    ULONG STDMETHODCALLTYPE Release() {
        ULONG ref = InterlockedDecrement(&m_ref);
        if (ref == 0) delete this;
        return ref;
    }

    HRESULT STDMETHODCALLTYPE DragEnter(IDataObject* pDataObj, DWORD grfKeyState, POINTL pt, DWORD* pdwEffect) {
        *pdwEffect = DROPEFFECT_COPY;
        
        auto files = GetFilePathsFromDataObject(pDataObj);
        if (!files.empty()) {
            std::vector<std::string> utf8_files;
            for(auto& w : files) {
                int size = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, NULL, 0, NULL, NULL);
                std::string s(size, 0);
                WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, &s[0], size, NULL, NULL);
                s.pop_back(); // remove null terminator
                utf8_files.push_back(s);
            }

            auto callback = [utf8_files](Napi::Env env, Napi::Function jsCallback) {
                Napi::Array arr = Napi::Array::New(env, utf8_files.size());
                for (size_t i = 0; i < utf8_files.size(); i++) {
                    arr[i] = Napi::String::New(env, utf8_files[i]);
                }
                jsCallback.Call({arr});
            };
            m_tsfn.BlockingCall(callback);
        }
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE DragOver(DWORD grfKeyState, POINTL pt, DWORD* pdwEffect) {
        *pdwEffect = DROPEFFECT_COPY;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE DragLeave() { return S_OK; }
    HRESULT STDMETHODCALLTYPE Drop(IDataObject* pDataObj, DWORD grfKeyState, POINTL pt, DWORD* pdwEffect) {
        *pdwEffect = DROPEFFECT_NONE;
        return S_OK;
    }
};

EdgeDropTarget* g_dropTarget = nullptr;

Napi::Value RegisterEdgeTarget(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsBuffer() || !info[1].IsFunction()) {
        Napi::TypeError::New(env, "Expected Buffer (HWND) and Function").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Buffer<uint8_t> hwndBuf = info[0].As<Napi::Buffer<uint8_t>>();
    HWND hwnd = *reinterpret_cast<HWND*>(hwndBuf.Data());

    Napi::Function cb = info[1].As<Napi::Function>();
    Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(
        env, cb, "EdgeDropTarget", 0, 1, [](Napi::Env) {}
    );

    OleInitialize(NULL);
    if (g_dropTarget) {
        RevokeDragDrop(hwnd);
        g_dropTarget->Release();
    }

    g_dropTarget = new EdgeDropTarget(tsfn);
    HRESULT hr = RegisterDragDrop(hwnd, g_dropTarget);
    if (FAILED(hr)) {
        Napi::Error::New(env, "RegisterDragDrop failed").ThrowAsJavaScriptException();
    }

    return env.Undefined();
}

Napi::Value StartDrag(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsArray() || !info[1].IsFunction()) {
        Napi::TypeError::New(env, "Expected Array of strings and Function").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Array arr = info[0].As<Napi::Array>();
    Napi::Function cb = info[1].As<Napi::Function>();

    std::vector<std::wstring> files;
    for (uint32_t i = 0; i < arr.Length(); i++) {
        Napi::Value val = arr[i];
        if (val.IsString()) {
            std::string s = val.As<Napi::String>().Utf8Value();
            int size = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, NULL, 0);
            std::wstring w(size, 0);
            MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, &w[0], size);
            w.pop_back(); // remove null terminator
            files.push_back(w);
        }
    }

    DragDropWorker* worker = new DragDropWorker(cb, files);
    worker->Queue();

    return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set(Napi::String::New(env, "registerEdgeTarget"), Napi::Function::New(env, RegisterEdgeTarget));
    exports.Set(Napi::String::New(env, "startDrag"), Napi::Function::New(env, StartDrag));
    return exports;
}

NODE_API_MODULE(omnibridge_dragdrop, Init)
