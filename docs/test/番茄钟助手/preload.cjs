const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('desktop',{notify:(title,body)=>ipcRenderer.invoke('notify',title,body)});
