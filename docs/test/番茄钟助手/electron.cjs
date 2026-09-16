const {app,BrowserWindow,ipcMain,Notification}=require('electron');const path=require('path');const fs=require('fs');
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu');
const runtime=path.join(__dirname,'.runtime'); fs.mkdirSync(runtime,{recursive:true});
for(const k of ['userData','sessionData','crashDumps','logs']){const d=path.join(runtime,k);fs.mkdirSync(d,{recursive:true});app.setPath(k,d)}
ipcMain.handle('notify',(_,title,body)=>{try{if(Notification.isSupported())new Notification({title,body}).show();return true}catch{return false}});
app.whenReady().then(()=>{const w=new BrowserWindow({width:1280,height:840,minWidth:420,minHeight:560,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false}});w.loadFile(path.join(__dirname,'dist/index.html')).catch(()=>w.loadURL('data:text/html,<h1>加载失败，请先运行 npm run build</h1>'));app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0) app.emit('ready')})});app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});


