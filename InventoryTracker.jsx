import { useState } from "react";

const initialData = [
  { size: "1/2\"", item: "ท่อ PVC ชั้น 8.5 (4 ม.)", unit: "ท่อน", quantity: 100 },
  { size: "1/2\"", item: "ข้อต่อตรง PVC", unit: "ชิ้น", quantity: 50 },
  { size: "1/2\"", item: "ข้องอ 90 องศา", unit: "ชิ้น", quantity: 40 },
  { size: "1/2\"", item: "ข้องอ 45 องศา", unit: "ชิ้น", quantity: 35 },
  { size: "1/2\"", item: "สามทาง PVC", unit: "ชิ้น", quantity: 30 },
  { size: "1/2\"", item: "สามทางลด PVC", unit: "ชิ้น", quantity: 25 },
  { size: "1/2\"", item: "ฝาครอบ PVC", unit: "ชิ้น", quantity: 20 },
  { size: "1/2\"", item: "ยูเนียน PVC", unit: "ชิ้น", quantity: 15 },
  { size: "1/2\"", item: "บอลวาล์ว PVC", unit: "ชิ้น", quantity: 10 },
  { size: "1/2\"", item: "หน้าแปลน PVC", unit: "ชิ้น", quantity: 5 },
];

export default function InventoryTracker() {
  const [inventory, setInventory] = useState(initialData);
  const [search, setSearch] = useState("");

  const updateQuantity = (index, delta) => {
    const newInventory = [...inventory];
    newInventory[index].quantity += delta;
    if (newInventory[index].quantity < 0) newInventory[index].quantity = 0;
    setInventory(newInventory);
  };

  const filteredInventory = inventory.filter(item =>
    item.item.includes(search) || item.size.includes(search)
  );

  return (
    <div style={{ padding: "2rem", maxWidth: "800px", margin: "auto" }}>
      <h1 style={{ fontSize: "1.8rem", fontWeight: "bold", marginBottom: "1rem" }}>📦 ระบบเช็คสต็อกวัสดุท่อ PVC</h1>
      <input
        type="text"
        placeholder="🔍 ค้นหาวัสดุหรือขนาด"
        style={{ padding: "0.5rem", width: "100%", marginBottom: "1rem" }}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th>ขนาด</th>
            <th>รายการวัสดุ</th>
            <th>หน่วย</th>
            <th>จำนวนคงเหลือ</th>
            <th>ปรับปรุง</th>
          </tr>
        </thead>
        <tbody>
          {filteredInventory.map((item, index) => (
            <tr key={index}>
              <td>{item.size}</td>
              <td>{item.item}</td>
              <td>{item.unit}</td>
              <td style={{ textAlign: "right" }}>{item.quantity}</td>
              <td>
                <button onClick={() => updateQuantity(index, 1)}>+1</button>
                <button onClick={() => updateQuantity(index, -1)}>-1</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
