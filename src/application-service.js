import { AppError, missing, forbidden, invalidState } from './errors.js';

function runInTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// TODO-01~04: 업무 규칙과 트랜잭션을 직접 구현합니다. docs/API.md를 먼저 읽으세요.
// actor는 검증된 로그인 사용자입니다. repo의 저장 함수는 권한을 검사하지 않습니다.
// 상태 변경과 이력 저장은 함께 성공하거나 함께 실패해야 합니다.
// 승인 취소와 자동 승급은 신청 2건 + 이력 2건을 한 트랜잭션으로 처리합니다.
export function createApplicationService(repo) {
  return {
    apply(actor, eventId) {
  return runInTransaction(repo.db, () => {
    const event = repo.event(eventId);
    if (!event) throw missing('행사');
    if (actor.role !== 'STUDENT') throw forbidden();
    if (repo.existing(eventId, actor.id)) {
      throw new AppError(409, 'ALREADY_APPLIED', '이미 신청한 행사입니다.');
    }
    const application = repo.insert(eventId, actor.id);
    repo.addHistory({
      applicationId: application.id,
      actorId: actor.id,
      action: 'APPLY',
      fromStatus: null,
      toStatus: 'PENDING'
    });
    return application;
  });
},
        cancel(actor, applicationId) {
      return runInTransaction(repo.db, () => {
        const app = repo.application(applicationId);
        if (!app) throw missing('신청');
        // 본인의 신청만 취소 가능 (운영자·타인은 403)
        if (actor.role !== 'STUDENT' || app.userId !== actor.id) throw forbidden();
        if (app.status !== 'PENDING') throw invalidState();
        const updated = repo.setStatus(app.id, 'CANCELLED');
        repo.addHistory({ applicationId: app.id, actorId: actor.id, action: 'CANCEL',
          fromStatus: 'PENDING', toStatus: 'CANCELLED' });
        return updated;
      });
    },
    approve(actor, applicationId) {
      return runInTransaction(repo.db, () => {
        const app = repo.application(applicationId);
        if (!app) throw missing('신청');
        const event = repo.event(app.eventId);
        // 해당 행사 담당 운영자만 승인 가능
        if (actor.role !== 'MANAGER' || event.managerId !== actor.id) throw forbidden();
        if (app.status !== 'PENDING') throw invalidState();
        if (repo.approvedCount(event.id) >= event.capacity) {
          throw new AppError(409, 'CAPACITY_FULL', '정원이 가득 찼습니다.');
        }
        const updated = repo.setStatus(app.id, 'APPROVED');
        repo.addHistory({ applicationId: app.id, actorId: actor.id, action: 'APPROVE',
          fromStatus: 'PENDING', toStatus: 'APPROVED' });
        return updated;
      });
    },
    revoke(actor, applicationId, reason) {
      return runInTransaction(repo.db, () => {
        const app = repo.application(applicationId);
        if (!app) throw missing('신청');
        const event = repo.event(app.eventId);
        if (actor.role !== 'MANAGER' || event.managerId !== actor.id) throw forbidden();
        if (app.status !== 'APPROVED') throw invalidState();

        // ①② 승인 취소 + REVOKE 이력 (이력 ID를 받아둔다)
        repo.setStatus(app.id, 'REVOKED');
        const revokeHistoryId = repo.addHistory({ applicationId: app.id, actorId: actor.id,
          action: 'REVOKE', fromStatus: 'APPROVED', toStatus: 'REVOKED', reason });

        // ③④ 대기자 1명 자동 승급 + AUTO_APPROVE 이력 (원인 = 위의 REVOKE 이력)
        let promoted = null;
        const next = repo.nextPending(app.eventId);
        if (next) {
          promoted = repo.setStatus(next.id, 'APPROVED');
          repo.addHistory({ applicationId: next.id, actorId: actor.id, action: 'AUTO_APPROVE',
            fromStatus: 'PENDING', toStatus: 'APPROVED', causeHistoryId: revokeHistoryId });
        }
        return { revoked: repo.application(app.id), promoted };
      });
    }
  };
}
