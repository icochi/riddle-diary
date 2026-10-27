import * as THREE from 'three';

/**
 * 羽梢避障运动学解算器深模块 (PlumeKinematics)
 *
 * 领域职责：
 * 1. 笔尖定轴避让 (Nib-Pivoted Clearance)：笔尖锚点咬合目标拾取点，遇到障碍时以笔尖为定点铰链；
 * 2. 墨水瓶越顶滑行 (Bottle Cresting)：临界半径内平滑提升高度以从瓶口越过；
 * 3. 羽梢横向偏航避让 (Plume Lateral Yaw Deflection)：避让墨水瓶圆柱体；
 * 4. 羽梢俯仰抬升避让 (Plume Pitch Elevation)：避让桌面与日记本边缘；
 * 5. 一阶惯性滤波平滑插值 (Smooth Filtering)。
 *
 * 零 DOM 依赖，零 GLTF 资产依赖，仅依赖纯数学几何与传入的顶点数据/包络参数。
 */
export class PlumeKinematics {
  /**
   * @param {Object} [options]
   * @param {Array<THREE.Vector3>} [options.localVertices=[]] 羽毛网格局部坐标顶点缓存
   * @param {THREE.Vector3} [options.bottlePos] 墨水瓶中心坐标
   * @param {number} [options.bottleRadius=0.165] 墨水瓶半径
   * @param {number} [options.bottleHeight=0.428] 墨水瓶上沿高度
   * @param {Object} [options.bookBounds] 日记本边界盒 { minX, maxX, minZ, maxZ, topY, bottomY }
   * @param {number} [options.groundY=0.0] 桌面基准 Y 高度
   */
  constructor(options = {}) {
    this.localVertices = options.localVertices || [];
    this.bottlePos = options.bottlePos ? options.bottlePos.clone() : new THREE.Vector3(-1.30, 0.12, 0.52);
    this.bottleRadius = options.bottleRadius ?? 0.165;
    this.bottleHeight = options.bottleHeight ?? 0.428;
    this.bookBounds = options.bookBounds || {
      minX: -1.08,
      maxX: 1.08,
      minZ: -0.78,
      maxZ: 0.78,
      topY: 0.12,
      bottomY: 0.0,
    };
    this.groundY = options.groundY ?? 0.0;

    // 平滑滤波状态内部维护 (隐藏在深模块内，外部无须感知)
    this.pitchOffset = 0.0;
    this.yawOffset = 0.0;
    this.bottleLiftOffset = 0.0;

    // 复用向量与四元数缓存
    this._tempVec = new THREE.Vector3();
    this._tempQuat = new THREE.Quaternion();
    this._stemDir = new THREE.Vector3();
    this._stemXZ = new THREE.Vector3();
    this._pitchAxis = new THREE.Vector3();
    this._upAxis = new THREE.Vector3(0, 1, 0);
  }

  setLocalVertices(vertices) {
    this.localVertices = vertices;
  }

  /**
   * 解算避障后的位姿
   * @param {Object} params
   * @param {THREE.Vector3} params.pos 基础位置
   * @param {THREE.Quaternion} params.quat 基础旋转
   * @param {number} params.dt 帧时间步长 (秒)
   * @param {number} [params.t=1.0] 插拔进度 (0.0~1.0)
   * @param {boolean} [params.isOverBook=false] 是否在书本上方
   * @param {number} [params.trapBlend=0.0] 瓶口捕获混合因子
   * @returns {{ pos: THREE.Vector3, quat: THREE.Quaternion }}
   */
  solve({ pos, quat, dt, t = 1.0, isOverBook = false, trapBlend = 0.0 }) {
    const finalPos = pos.clone();
    const finalQuat = quat.clone();

    if (this.localVertices.length === 0 || t <= 0.05) {
      return { pos: finalPos, quat: finalQuat };
    }

    const bPos = this.bottlePos;
    const bRad = this.bottleRadius;
    const bTop = this.bottleHeight;

    // 1. 墨水瓶平滑越顶高度抬升 (Bottle Cresting)
    let targetBottleLift = 0;
    if (trapBlend < 0.75 && !isOverBook) {
      const distToBottle = Math.hypot(finalPos.x - bPos.x, finalPos.z - bPos.z);
      const outerDomeRadius = 0.32;
      const innerDomeRadius = bRad;
      if (distToBottle < outerDomeRadius) {
        const maxLift = Math.max(0, bTop - this.groundY + 0.02);
        if (distToBottle <= innerDomeRadius) {
          targetBottleLift = maxLift;
        } else {
          const u = 1 - (distToBottle - innerDomeRadius) / (outerDomeRadius - innerDomeRadius);
          targetBottleLift = maxLift * (u * u * (3 - 2 * u));
        }
      }
    }

    const bottleLiftRate = targetBottleLift > this.bottleLiftOffset
      ? Math.min(1.0, dt * 25)
      : Math.min(1.0, dt * 10);
    this.bottleLiftOffset = THREE.MathUtils.lerp(this.bottleLiftOffset, targetBottleLift, bottleLiftRate);
    finalPos.y += this.bottleLiftOffset * t;

    // 2. 羽梢横向偏航避让 (Plume Lateral Yaw Deflection - 墨水瓶避让)
    let targetYaw = 0;
    let targetPitchExtra = 0;
    if (trapBlend < 0.75 && !isOverBook) {
      let maxBottlePen = 0;
      let worstRx = 0;
      let worstRz = 0;

      for (let i = 0; i < this.localVertices.length; i++) {
        const v = this.localVertices[i];
        if (v.length() < 0.015) continue;
        this._tempVec.copy(v).applyQuaternion(finalQuat).add(finalPos);

        if (this._tempVec.y < bTop) {
          const dx = this._tempVec.x - bPos.x;
          const dz = this._tempVec.z - bPos.z;
          const dist = Math.hypot(dx, dz);
          if (dist < bRad) {
            const pen = bRad - dist;
            if (pen > maxBottlePen) {
              maxBottlePen = pen;
              worstRx = this._tempVec.x - finalPos.x;
              worstRz = this._tempVec.z - finalPos.z;
            }
          }
        }
      }

      if (maxBottlePen > 0) {
        const bx = bPos.x - finalPos.x;
        const bz = bPos.z - finalPos.z;
        const cross = worstRx * bz - worstRz * bx;
        const preferredSign = Math.abs(cross) < 0.001 ? 1 : (cross >= 0 ? -1 : 1);
        const altSign = -preferredSign;

        const checkBottlePen = (rad, extraPitchRad = 0) => {
          this._tempQuat.setFromAxisAngle(this._upAxis, rad).multiply(finalQuat);
          if (extraPitchRad > 0) {
            const sDir = new THREE.Vector3(0, 1, 0).applyQuaternion(this._tempQuat);
            const sXZ = new THREE.Vector3(sDir.x, 0, sDir.z);
            if (sXZ.lengthSq() > 0.00001) {
              const pAxis = new THREE.Vector3().crossVectors(sXZ, this._upAxis).normalize();
              const pQuat = new THREE.Quaternion().setFromAxisAngle(pAxis, extraPitchRad);
              this._tempQuat.premultiply(pQuat);
            }
          }
          let pen = 0;
          for (let i = 0; i < this.localVertices.length; i++) {
            if (this.localVertices[i].length() < 0.015) continue;
            this._tempVec.copy(this.localVertices[i]).applyQuaternion(this._tempQuat).add(finalPos);
            if (this._tempVec.y < bTop) {
              const dist = Math.hypot(this._tempVec.x - bPos.x, this._tempVec.z - bPos.z);
              if (dist < bRad) {
                pen = Math.max(pen, bRad - dist);
              }
            }
          }
          return pen;
        };

        let foundDeg = 0;
        for (let deg = 2; deg <= 70 && !foundDeg; deg += 2) {
          for (const sign of [preferredSign, altSign]) {
            if (checkBottlePen(sign * THREE.MathUtils.degToRad(deg)) <= 0) {
              foundDeg = sign * deg;
              break;
            }
          }
        }

        if (foundDeg !== 0) {
          targetYaw = THREE.MathUtils.degToRad(foundDeg);
        } else {
          targetYaw = preferredSign * THREE.MathUtils.degToRad(60);
          for (let pDeg = 5; pDeg <= 45; pDeg += 5) {
            if (checkBottlePen(targetYaw, THREE.MathUtils.degToRad(pDeg)) <= 0) {
              targetPitchExtra = THREE.MathUtils.degToRad(pDeg);
              break;
            }
          }
        }
      }
    }

    const yawRate = Math.abs(targetYaw) > Math.abs(this.yawOffset)
      ? Math.min(1.0, dt * 25)
      : Math.min(1.0, dt * 8);
    this.yawOffset = THREE.MathUtils.lerp(this.yawOffset, targetYaw, yawRate);

    if (Math.abs(this.yawOffset) > 0.0001) {
      this._tempQuat.setFromAxisAngle(this._upAxis, this.yawOffset * t);
      finalQuat.premultiply(this._tempQuat);
    }

    // 3. 羽梢俯仰抬升避让 (Plume Pitch Elevation)
    this._stemDir.set(0, 1, 0).applyQuaternion(finalQuat);
    this._stemXZ.set(this._stemDir.x, 0, this._stemDir.z);
    let targetPitch = 0;

    if (!isOverBook) {
      targetPitch = targetPitchExtra;
      if (this._stemXZ.lengthSq() > 0.00001) {
        this._pitchAxis.crossVectors(this._stemXZ, this._upAxis).normalize();
        const book = this.bookBounds;

        const checkGroundPen = (rad) => {
          this._tempQuat.setFromAxisAngle(this._pitchAxis, rad).multiply(finalQuat);
          let pen = 0;
          for (let i = 0; i < this.localVertices.length; i++) {
            if (this.localVertices[i].length() < 0.015) continue;
            this._tempVec.copy(this.localVertices[i]).applyQuaternion(this._tempQuat).add(finalPos);
            const isOverBookVertex = (
              this._tempVec.x >= book.minX &&
              this._tempVec.x <= book.maxX &&
              this._tempVec.z >= book.minZ &&
              this._tempVec.z <= book.maxZ
            );
            const minAllowedY = isOverBookVertex ? book.topY + 0.002 : this.groundY + 0.002;
            if (this._tempVec.y < minAllowedY) {
              pen = Math.max(pen, minAllowedY - this._tempVec.y);
            }
          }
          return pen;
        };

        if (checkGroundPen(targetPitch) > 0) {
          for (let deg = Math.max(1, Math.round(THREE.MathUtils.radToDeg(targetPitch))); deg <= 60; deg += 2) {
            if (checkGroundPen(THREE.MathUtils.degToRad(deg)) <= 0) {
              targetPitch = THREE.MathUtils.degToRad(deg);
              break;
            }
          }
        }
      }
    }

    const pitchRate = targetPitch > this.pitchOffset
      ? Math.min(1.0, dt * 30)
      : Math.min(1.0, dt * 15);
    this.pitchOffset = THREE.MathUtils.lerp(this.pitchOffset, targetPitch, pitchRate);

    if (this.pitchOffset > 0.0001) {
      this._tempQuat.setFromAxisAngle(this._pitchAxis, this.pitchOffset * t);
      finalQuat.premultiply(this._tempQuat);
    }

    return { pos: finalPos, quat: finalQuat };
  }
}
