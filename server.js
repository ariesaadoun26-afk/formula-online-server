
'use strict';
const express=require('express');
const http=require('http');
const {Server}=require('socket.io');
const app=express();
app.get('/',(_,res)=>res.json({service:'Formula Online server',status:'ok',playersPerRoom:4}));
app.get('/health',(_,res)=>res.json({ok:true,rooms:rooms.size}));
const httpServer=http.createServer(app);
const io=new Server(httpServer,{cors:{origin:'*',methods:['GET','POST']},transports:['websocket','polling']});
const rooms=new Map();
const MAX_PLAYERS=4, LAP_DISTANCE=1800, TOTAL_LAPS=3, TICK_MS=50;
const COLORS=['#ff4757','#36a3ff','#ffbf36','#41d9a0'];
const cleanName=x=>String(x||'נהג').trim().slice(0,18).replace(/[<>]/g,'')||'נהג';
const cleanCode=x=>String(x||'').replace(/\D/g,'').slice(0,6);
const broadcast=(room)=>io.to(room.code).emit('room:update',publicRoom(room));
function publicRoom(room){
 return {code:room.code,host:room.host,status:room.status,countdownEnd:room.countdownEnd||null,
 players:[...room.players.values()].map(p=>({id:p.id,name:p.name,color:p.color,ready:p.ready,lane:p.lane,progress:p.progress,speed:p.speed,boost:p.boost,missiles:p.missiles,oil:p.oil,stunUntil:p.stunUntil,finishedAt:p.finishedAt,connected:p.connected})),
 hazards:room.hazards||[],winner:room.winner||null};
}
function uniqueCode(){let c;do{c=String(Math.floor(100000+Math.random()*900000));}while(rooms.has(c));return c;}
function sendAck(ack,obj){if(typeof ack==='function')ack(obj)}
function leave(socket){
 const code=socket.data.code;if(!code)return;
 const room=rooms.get(code);socket.leave(code);delete socket.data.code;
 if(!room)return;
 room.players.delete(socket.id);
 if(room.host===socket.id)room.host=room.players.keys().next().value||null;
 if(room.players.size===0){rooms.delete(code);return;}
 if(room.status==='countdown'){room.status='lobby';room.countdownEnd=null;}
 broadcast(room);
}
io.on('connection',socket=>{
 socket.on('room:create',(data,ack)=>{
  leave(socket);
  const code=uniqueCode();
  const room={code,host:socket.id,status:'lobby',players:new Map(),countdownEnd:null,winner:null};
  rooms.set(code,room);
  join(room,data,socket);sendAck(ack,{ok:true,room:publicRoom(room)});
 });
 socket.on('room:join',(data,ack)=>{
  const code=cleanCode(data?.code),room=rooms.get(code);
  if(!room)return sendAck(ack,{ok:false,error:'לא נמצא חדר עם הקוד הזה'});
  if(room.status!=='lobby')return sendAck(ack,{ok:false,error:'המרוץ כבר התחיל'});
  if(room.players.size>=MAX_PLAYERS)return sendAck(ack,{ok:false,error:'החדר מלא'});
  leave(socket);join(room,data,socket);sendAck(ack,{ok:true,room:publicRoom(room)});
 });
 socket.on('player:ready',(value)=>{
  const room=rooms.get(socket.data.code),p=room?.players.get(socket.id);
  if(!p||room.status!=='lobby')return;
  p.ready=!!value;broadcast(room);
 });
 socket.on('race:start',(_,ack)=>{
  const room=rooms.get(socket.data.code);
  if(!room||room.host!==socket.id)return sendAck(ack,{ok:false,error:'רק מנהל החדר יכול להתחיל'});
  if(room.status!=='lobby')return sendAck(ack,{ok:false,error:'המרוץ כבר התחיל'});
  if(room.players.size<2)return sendAck(ack,{ok:false,error:'צריך לפחות שני שחקנים'});
  if([...room.players.values()].some(p=>p.id!==room.host&&!p.ready))return sendAck(ack,{ok:false,error:'ממתינים שכל השחקנים יהיו מוכנים'});
  let i=0;room.hazards=[];for(const p of room.players.values()){p.progress=Math.floor(i/3)*-22;p.lane=i%3;p.speed=0;p.boost=100;p.missiles=2;p.oil=2;p.stunUntil=0;p.finishedAt=null;p.input={gas:true,brake:false,boost:false};i++;}
  room.status='countdown';room.countdownEnd=Date.now()+3500;room.winner=null;
  broadcast(room);sendAck(ack,{ok:true});
 });
 socket.on('drive:input',data=>{
  const room=rooms.get(socket.data.code),p=room?.players.get(socket.id);
  if(!p||room.status!=='racing'||p.finishedAt)return;
  if(Number.isInteger(data?.lane)&&data.lane>=0&&data.lane<=2)p.lane=data.lane;
  p.input={gas:true,brake:!!data?.brake,boost:!!data?.boost};
 });
 socket.on('weapon:use',(data,ack)=>{
  const room=rooms.get(socket.data.code),p=room?.players.get(socket.id);
  if(!room||room.status!=='racing'||!p||p.finishedAt)return sendAck(ack,{ok:false});
  const now=Date.now();
  if(data?.type==='missile'){
   if(p.missiles<=0)return sendAck(ack,{ok:false,error:'אין רקטות'});
   const targets=[...room.players.values()].filter(q=>q.id!==p.id&&!q.finishedAt&&q.progress>=p.progress-18&&q.progress-p.progress<260);
   targets.sort((a,b)=>Math.abs(a.progress-p.progress)-Math.abs(b.progress-p.progress));
   p.missiles--;
   const target=targets[0];
   if(target){target.stunUntil=now+1250;target.speed=Math.min(target.speed,65);}
   io.to(room.code).emit('weapon:effect',{type:'missile',from:p.id,to:target?.id||null,at:p.progress});
   sendAck(ack,{ok:true,hit:!!target});broadcast(room);
  }else if(data?.type==='oil'){
   if(p.oil<=0)return sendAck(ack,{ok:false,error:'אין שמן'});
   p.oil--;
   room.hazards.push({id:Math.random().toString(36).slice(2),owner:p.id,lane:p.lane,progress:p.progress-12,expires:now+14000});
   io.to(room.code).emit('weapon:effect',{type:'oil',from:p.id,at:p.progress});
   sendAck(ack,{ok:true});broadcast(room);
  }
 });
 socket.on('room:leave',()=>leave(socket));
 socket.on('disconnect',()=>leave(socket));
});
function join(room,data,socket){
 const idx=room.players.size;
 room.players.set(socket.id,{id:socket.id,name:cleanName(data?.name),color:COLORS[idx%4],ready:false,lane:1,progress:0,speed:0,boost:100,missiles:2,oil:2,stunUntil:0,finishedAt:null,connected:true,input:{gas:true,brake:false,boost:false}});
 socket.join(room.code);socket.data.code=room.code;broadcast(room);
}
setInterval(()=>{
 const now=Date.now();
 for(const room of rooms.values()){
  if(room.status==='countdown'&&now>=room.countdownEnd){room.status='racing';broadcast(room);}
  if(room.status!=='racing')continue;
  room.hazards=(room.hazards||[]).filter(h=>h.expires>now);
  for(const p of room.players.values()){
   if(p.finishedAt)continue;
   const boosting=p.input.boost&&p.boost>0&&!p.input.brake;
   const target=p.input.brake?65:boosting?520:370;
   p.speed+=(target-p.speed)*0.13;
   if(p.stunUntil>now)p.speed=Math.min(p.speed,85);
   p.boost=Math.max(0,Math.min(100,p.boost+(boosting?-22:9)*TICK_MS/1000));
   p.progress+=p.speed/3.6*TICK_MS/1000;
   for(const h of room.hazards){
    if(h.owner!==p.id&&h.lane===p.lane&&Math.abs(p.progress-h.progress)<4){
      p.stunUntil=now+1700;p.speed=45;h.expires=0;
      io.to(room.code).emit('weapon:effect',{type:'oilHit',to:p.id,at:p.progress});
    }
   }
   if(p.progress>=LAP_DISTANCE*TOTAL_LAPS){
    p.progress=LAP_DISTANCE*TOTAL_LAPS;p.finishedAt=now;
    if(!room.winner)room.winner=p.id;
   }
  }
  if([...room.players.values()].every(p=>p.finishedAt)){room.status='finished';}
  io.to(room.code).emit('race:state',publicRoom(room));
 }
},TICK_MS);
httpServer.listen(process.env.PORT||3000,()=>console.log('Formula online server running'));
