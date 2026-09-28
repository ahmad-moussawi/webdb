import React from 'react';
import { useStudio } from '../../context/StudioContext';

export const BytecodeView: React.FC = () => {
  const { explainOutput } = useStudio();

  if (!explainOutput) {
    return (
      <div id="bytecodeView" className="bytecode-view" style={{ display: 'block' }}>
        {`// VDBE Bytecode Disassembly & Plan
// Note: To automatically inspect the compiled VDBE bytecode plan, return
// the query builder directly without calling .toArray():
//
//   return db.from("products").where("price", ">=", 100);
//
// WebDB Studio will automatically compile, explain, and execute it.`}
      </div>
    );
  }

  const text = `// VDBE Bytecode Size: ${explainOutput.bytecodeSize || 0} bytes\n// Plan: ${JSON.stringify(explainOutput.plan, null, 2)}\n\n${explainOutput.assembly || ''}`;

  return (
    <div id="bytecodeView" className="bytecode-view" style={{ display: 'block' }}>
      {text}
    </div>
  );
};
