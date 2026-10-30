// 三种数量方式共用同一计算，避免目录、断点、报告和模型上下文各算各的。
export function validateMemberScope({limit=10,allMembers=false,memberPercent}={}){
 if(typeof allMembers!=='boolean'||!Number.isInteger(limit)||limit<1||limit>10)throw Error('每板块数量须为1—10；全量请显式选择全部成分股');
 if(memberPercent!=null&&(!Number.isInteger(memberPercent)||memberPercent<1||memberPercent>100))throw Error('每板块百分比须为1—100整数');
 if(allMembers&&memberPercent!=null)throw Error('全部成分股与百分比只能选择一种');
}
export function memberTarget(total,scope={}){
 validateMemberScope(scope);
 if(!Number.isSafeInteger(total)||total<1)throw Error('板块总成分数无效');
 if(scope.allMembers)return total;
 if(scope.memberPercent!=null){if(!Number.isSafeInteger(total*scope.memberPercent))throw Error('板块成分数超出计算范围');return Math.ceil(total*scope.memberPercent/100);}
 return Math.min(scope.limit??10,total);
}
export function memberScopeLabel(scope={}){
 validateMemberScope(scope);
 return scope.allMembers?'全部成分股':scope.memberPercent!=null?'每板块前'+scope.memberPercent+'%（按总数向上取整）':'每板块前'+(scope.limit??10)+'只';
}
