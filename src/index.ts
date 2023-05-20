import { WebSocket } from 'ws';

interface SocketPackage {
    info: SocketPackageInfo,
    data: any
}
interface SocketPackageInfo {
    action   : SocketAction
    request  : string | number,
    group    : string,
    packageID: number
}
interface SocketPackageResponse {
    info    : SocketPackageInfo,
    error   : any,
    response: any
}
interface SocketServerCallsStack {
    [key: number]:  (error: any, response: any) => void
}
interface SocketListeners {
    [key: string]:  ((response: any) => void)[]
}

type SocketAction = 'group' | 'call' | 'auth' | 'broadcast';
interface SocketConnectorOptions {
    onConnectionErrorReconnect?: boolean,
    authCallbackOnReconnect?   : boolean,
    reconnectionTimeout?       : number,
}
export class WebSocketServerSideClient {
    public webSocket: WebSocket = null;
    private packageID: number    = 0;
    private _session  : any       = null

    private onServerResponse:SocketServerCallsStack = {};
    private broadcastListeners :SocketListeners     = {};

    private authCredentials:any     = {};
    private url:string              = null;
    private reconnect: boolean      = true;
    private hasBeingConnectedBefore = false;

    private onConnectionErrorReconnect :boolean = true;
    private authCallbackOnReconnect    :boolean = true;
    private reconnectionTimeout        :number  = 2_000;

    private _onConnectionError :(error: any, info: any) => void         = console.error;
    private _onConnectionClose :(error: any, info: any) => void         = console.log;
    private _whenConnected :() => void                                 = () => {};
    private _ifAuthenticationFails :(authenticationError: any) => void = () => {};
   
    constructor(connectionOptions:SocketConnectorOptions = null) {
        if(connectionOptions){
            this.onConnectionErrorReconnect = connectionOptions.onConnectionErrorReconnect || this.onConnectionErrorReconnect;
            this.authCallbackOnReconnect    = connectionOptions.authCallbackOnReconnect    || this.authCallbackOnReconnect;
            this.reconnectionTimeout        = connectionOptions.reconnectionTimeout        || this.reconnectionTimeout;
        }
    }

    private ReloadConnection = (reconnectionWait:number = this.reconnectionTimeout) => {
        if(this.reconnect ) {
            setTimeout(() => {
                try {
                    this.ClearWebSocket();
                    this.StartSocket();                
                } catch(e){
                    this._onConnectionError('connection error',e);
                }
            },reconnectionWait);
        }
    }

    private ResetControllers = () => {
        this.packageID          = 0;
        this._session            = null;
        this.onServerResponse   = {};
        this.broadcastListeners = {};
    }

    private StartSocket = () => {
        this.ResetControllers();
        this.webSocket = new WebSocket(this.url);
        this.webSocket.on('error',this.onConnError);
        this.webSocket.on('close',this.onConnClose);
        this.webSocket.on('open',this.onConnOpen);
        this.webSocket.on('message',this.onConnMessage);
    }

    private ClearWebSocket = () => {
        if(!this.webSocket) return; 
        this.webSocket.terminate();
        this.webSocket.removeAllListeners();
        this.webSocket = null;
    }

    private onConnError = (e:any) => {
        this._onConnectionError('connection error',e);
        if (this.onConnectionErrorReconnect) this.ReloadConnection();
    }

    private onConnClose = (e:any) => {
        if (this.session) this._onConnectionClose('connection closed',e);
    }

    private onConnMessage = (incomingData:any) => {
        let packageResponse:SocketPackageResponse = null;
        try {
            packageResponse = JSON.parse(incomingData);
        } catch (e) {
            this._onConnectionError( 'invalid incoming data: ', incomingData);
        }
        this.HandleServerMessage(packageResponse);
    }

    private onConnOpen = () => {
        this.Send<any>('auth','login',null,this.authCredentials,(error,sessionData) => {
            if(error){
                this._session   = null;
                this.reconnect = false;
                this._ifAuthenticationFails(error);
            } else {
                this._session = sessionData;
                if (this.hasBeingConnectedBefore) {
                    if (this.authCallbackOnReconnect) this._whenConnected();
                } else {
                    this.hasBeingConnectedBefore = true;
                    this._whenConnected();
                }
            }
        });
    }

    private HandleServerMessage = (r:SocketPackageResponse) => {
        let { info,error,response } = r;
        if(info.action == "broadcast"){
            let { request } = info;
            if(this.broadcastListeners[request]) {
                let listeners = this.broadcastListeners[request];
                listeners.forEach(fn => fn(response));
            }
        } else {
            let isServerResponse = info.action == "call" || info.action == "group" || info.action == "auth"
            if(isServerResponse){
                let { packageID } = info;
                if(this.onServerResponse[packageID]){
                    let onResponseToPackage = this.onServerResponse[packageID];
                    onResponseToPackage(error,response);
                    delete this.onServerResponse[packageID];
                }
            }
        }
    }

    private Send = <T = any> (action:SocketAction,request:string | number,group:string = '',data:any = null,cbOnResponse:(error: any, response: T) => void  = null) => {
        if(this._session || (action == 'auth' && request == 'login')){
            let info: SocketPackageInfo = { action,request,group,packageID:this.packageID } ;
            let body:SocketPackage      = { info, data}
            if(cbOnResponse) {
                this.onServerResponse[this.packageID] = cbOnResponse;
                this.packageID++;
            }
            this.webSocket.send(JSON.stringify(body));
        } else {
            cbOnResponse('not authenticated',null);
        }
    }

    public connectTo = <T = any>(websocketServerURL:string,newAuthCredentials:T = null) => {
        let u = websocketServerURL;
        if(u.startsWith('http://'))  u = u.replace('http://','ws://')
        if(u.startsWith('https://')) u = u.replace('https://','wss://')
        if(u.startsWith('/') ) u = 'ws://' + window.location.hostname + u;
        this.url                      = u;
        this.reconnect                = true;
        this.hasBeingConnectedBefore  = false;
        this.authCredentials          = newAuthCredentials || this.authCredentials;
        this.ReloadConnection(1);
        return this;
    }

    public echo = <T = any>(data:T,cb:(error: any, response: {echoAt:number,received:T}) => void = null) => {
        this.Send<{echoAt:number,received:T}>('call','echo',null,data,cb);
    }

    public request = <T = any,R= any>(request:string | number,data:R,cb:(error: any, response: T) => void = null) => {
        this.Send('call',request,null,data,cb);
    }

    public joinGroup = (group:string,cb:(error: any, response: {done:boolean}) => void = null) => {
        this.Send('group','join',group,null,cb);
    }

    public leaveGroup = (group:string,cb:(error: any, response: {done:boolean}) => void = null) => {
        this.Send('group','leave',group,null,cb);
    }

    public leaveAllGroups = (cb:(error: any, response: {done:boolean}) => void = null) => {
        this.Send('group','leaveAll',null,null,cb);
    }

    public onMessageReceived = <T = any>(subject:string,cb:(incomingData: T) => void) => {
        if(!this.broadcastListeners[subject]) this.broadcastListeners[subject] = [];
        this.broadcastListeners[subject].push(cb);
    }

    public get close (){
        this.reconnect = false;
        this.ClearWebSocket();
        this.ResetControllers();
        return null;
    }

    public set onConnectionError(oce: (error:any,info:any) => void) {
        this._onConnectionError = oce;
    }

    public set onConnectionClosed(occ: (error:any,info:any) => void) {
        this._onConnectionClose = occ;
    }

    public set ifAuthenticationFails(oaf: (authenticationError:any) => void) {
        this._ifAuthenticationFails = oaf;
    }

    public set whenConnected(oc: () => void) {
        this._whenConnected = oc;
    }

    public get session(){
        return this._session;
    }

    public get isConnected(){
        return this._session != null;
    }
}